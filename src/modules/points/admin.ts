import { PointTxType, PointType } from '@/generated/prisma/enums.ts'
import { errors } from '@/lib/api/errors.ts'
import { AUDIT_ACTIONS, AUDIT_TARGETS, writeAuditLog } from '@/modules/audit/service.ts'
import { type PrismaTransactionClient } from '@/server/db.ts'

import { consumePoints, getBalance, grantPoints } from './ledger.ts'

/**
 * 管理者によるポイント調整。
 *
 * 要件:
 *  - 理由入力を必須にする
 *  - 直接残高を書き換えない
 *  - ポイント台帳に ADJUSTMENT として記録する
 *  - audit_logs に記録する
 *
 * 残高を直接書き換える経路はコード上に存在しない。
 * 増額は新しいロットの発行、減額は通常の消費と同じ手順で行う。
 *
 * 【重要】自分ではトランザクションを開かない。
 *   呼び出し元（withIdempotentApi）がすでにトランザクションを開いているため、
 *   ここで prisma.$transaction を呼ぶと別コネクション上の入れ子になり、
 *   外側がロールバックしても調整だけが残ってしまう。
 */

export interface AdjustPointsInput {
  userId: string
  /** 正で増額、負で減額 */
  amount: number
  reason: string
  /** 増額時に発行するポイントの種別。減額時は無視される。 */
  pointType?: PointType
  /**
   * この調整リクエストを一意に識別する値（冪等性キーの ID）。
   *
   * 台帳には (source_type, source_id, tx_type) の一意制約があるため、
   * ここに実行者 ID を入れてしまうと「管理者 1 人につき生涯 1 回しか
   * 調整できない」ことになる。リクエスト単位の値を入れること。
   * 実行者は ledger.createdBy と監査ログに記録される。
   */
  requestId: string
}

export interface AdjustPointsResult {
  userId: string
  amount: number
  balanceAfter: number
  ledgerEntryId: string
}

export async function adjustUserPoints(
  tx: PrismaTransactionClient,
  input: AdjustPointsInput,
  actor: { id: string },
  context: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<AdjustPointsResult> {
  if (input.amount === 0) {
    throw errors.validation([{ field: 'amount', message: '0 ポイントの調整はできません' }])
  }

  const reason = input.reason.trim()
  if (reason.length === 0) {
    throw errors.reasonRequired()
  }

  const user = await tx.user.findFirst({
    where: { id: input.userId, deletedAt: null },
    select: { id: true },
  })
  if (!user) {
    throw errors.notFound('ユーザー')
  }

  const before = await getBalance(tx, input.userId)

  const result =
    input.amount > 0
      ? await grantPoints(
          tx,
          {
            userId: input.userId,
            amount: input.amount,
            // 管理者による付与は無償ポイント扱い。
            // 有償扱いにすると、対価の裏付けが無いまま前払式支払手段の
            // 残高を増やすことになるため。
            pointType: input.pointType ?? PointType.FREE,
            txType: PointTxType.ADJUSTMENT,
            sourceType: 'ADMIN_ADJUSTMENT',
            sourceId: input.requestId,
            reason,
          },
          { actorId: actor.id },
        )
      : await consumePoints(
          tx,
          {
            userId: input.userId,
            amount: Math.abs(input.amount),
            txType: PointTxType.ADJUSTMENT,
            sourceType: 'ADMIN_ADJUSTMENT',
            sourceId: input.requestId,
            reason,
          },
          { actorId: actor.id },
        )

  const after = await getBalance(tx, input.userId)

  await writeAuditLog(
    {
      actorType: 'ADMIN',
      actorId: actor.id,
      action: AUDIT_ACTIONS.POINT_ADJUST,
      targetType: AUDIT_TARGETS.POINT_ACCOUNT,
      targetId: input.userId,
      reason,
      before: { total: before.total, paid: before.paid, free: before.free },
      after: {
        total: after.total,
        paid: after.paid,
        free: after.free,
        adjustedBy: input.amount,
      },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    },
    tx,
  )

  return {
    userId: input.userId,
    amount: input.amount,
    balanceAfter: after.total,
    ledgerEntryId: result.ledgerEntryId,
  }
}
