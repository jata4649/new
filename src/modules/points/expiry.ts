import { PointTxType, PointType } from '@/generated/prisma/enums.ts'
import { now } from '@/lib/datetime/index.ts'
import { logger } from '@/lib/observability/index.ts'
import { AUDIT_ACTIONS, AUDIT_TARGETS, writeAuditLog } from '@/modules/audit/service.ts'
import { prisma, TRANSACTION_OPTIONS } from '@/server/db.ts'

import { applyBalanceDelta, lockExpiredLots, markLotExpired } from './repository.ts'

/**
 * ポイントの有効期限切れ処理。
 *
 * ■ このバッチが遅れても、期限切れポイントは使えない
 *   残高の参照と消費は常に `expires_at > now()` で絞っているため、
 *   バッチ未実行でも失効済みポイントが使われることはない。
 *   このバッチの役割は「台帳へ記帳し、口座キャッシュを実態へ合わせる」こと。
 *
 * ■ 少しずつ処理する
 *   1 回のトランザクションで扱う件数を制限し、長時間ロックを避ける。
 *   FOR UPDATE SKIP LOCKED により、並行実行しても同じロットを二重処理しない。
 */

export interface ExpiryResult {
  processedLots: number
  expiredPoints: number
  affectedUsers: number
}

const DEFAULT_BATCH_SIZE = 200

export async function expirePoints(
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<ExpiryResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = options.maxBatches ?? 100

  let processedLots = 0
  let expiredPoints = 0
  const affectedUsers = new Set<string>()

  for (let batch = 0; batch < maxBatches; batch++) {
    const processed = await prisma.$transaction(async (tx) => {
      const at = now()
      const lots = await lockExpiredLots(tx, at, batchSize)
      if (lots.length === 0) return 0

      // ユーザーごとにまとめて記帳する（1 ユーザー 1 記帳）
      const byUser = new Map<string, { paid: number; free: number; lotIds: string[] }>()

      for (const lot of lots) {
        const applied = await markLotExpired(tx, lot.id, at)
        if (!applied) continue

        const bucket = byUser.get(lot.userId) ?? { paid: 0, free: 0, lotIds: [] }
        if (lot.pointType === PointType.PAID) {
          bucket.paid += lot.amountRemaining
        } else {
          bucket.free += lot.amountRemaining
        }
        bucket.lotIds.push(lot.id)
        byUser.set(lot.userId, bucket)
      }

      for (const [userId, bucket] of byUser) {
        const total = bucket.paid + bucket.free
        if (total === 0) continue

        const balance = await applyBalanceDelta(tx, userId, -bucket.paid, -bucket.free)
        if (!balance) {
          // 口座キャッシュが実態より小さい。台帳が真実なので調査が必要。
          logger.error('失効処理で残高の更新に失敗しました', {
            userId,
            paid: bucket.paid,
            free: bucket.free,
          })
          throw new Error(`失効処理で残高の更新に失敗しました: user=${userId}`)
        }

        await tx.pointLedgerEntry.create({
          data: {
            userId,
            txType: PointTxType.EXPIRE,
            pointType:
              bucket.paid > 0 && bucket.free > 0
                ? null
                : bucket.paid > 0
                  ? PointType.PAID
                  : PointType.FREE,
            amount: -total,
            balanceAfter: balance.paidBalance + balance.freeBalance,
            sourceType: 'EXPIRY_BATCH',
            sourceId: bucket.lotIds[0] ?? null,
          },
        })

        await writeAuditLog(
          {
            actorType: 'SYSTEM',
            action: AUDIT_ACTIONS.POINT_EXPIRED,
            targetType: AUDIT_TARGETS.POINT_ACCOUNT,
            targetId: userId,
            after: { expiredPoints: total, lotCount: bucket.lotIds.length },
          },
          tx,
        )

        expiredPoints += total
        affectedUsers.add(userId)
      }

      return lots.length
    }, TRANSACTION_OPTIONS)

    processedLots += processed
    if (processed === 0) break
  }

  return {
    processedLots,
    expiredPoints,
    affectedUsers: affectedUsers.size,
  }
}
