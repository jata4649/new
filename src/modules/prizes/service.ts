import {
  InventoryStatus,
  PointTxType,
  PointType,
  PrizeStatus,
} from '@/generated/prisma/enums.ts'
import { errors } from '@/lib/api/errors.ts'
import { now } from '@/lib/datetime/index.ts'
import { AUDIT_ACTIONS, AUDIT_TARGETS, writeAuditLog } from '@/modules/audit/service.ts'
import { grantPoints } from '@/modules/points/ledger.ts'
import type { PrismaTransactionClient } from '@/server/db.ts'

import { lockPrizeForUpdate } from './repository.ts'

/**
 * 当選商品のポイント交換。
 *
 * ■ 取消不可である理由
 *   交換するとポイントが発行され、在庫は EXCHANGED になって再販可能になる。
 *   あとから取り消すと「発行済みポイントを消す」ことになり、
 *   利用者がすでに使っていた場合に残高がマイナスになりうる。
 *   台帳を追記専用にしている以上、取消しは逆仕訳として別途設計すべきもので、
 *   「なかったことにする」経路は作らない。
 *
 * ■ 二重交換が起きない理由（3 層）
 *   1. 行ロック（FOR UPDATE）＋ ロック後の状態再確認
 *   2. 条件付き UPDATE（status = 'UNDECIDED' のときだけ遷移）＋ 件数検査
 *   3. 台帳の (source_type, source_id, tx_type) UNIQUE
 *      → 同じ当選商品からの PRIZE_EXCHANGE 記帳は DB が 1 件しか許さない
 *
 *   3 層目だけでも二重付与は防げるが、それだと利用者へ返るのが
 *   一意制約違反（500）になってしまう。1 層目のロックがあるおかげで
 *   「すでに交換済みです（409）」と正しく伝えられる。
 *   同時実行テストがこの差を検証している。
 *
 * ■ 付与するのは無償ポイント
 *   対価を伴って発行したものではないため PAID にしない。
 *   有効期限も無償ポイントの設定に従う（docs/07-point-ledger.md）。
 */

export interface ExchangeParams {
  userId: string
  prizeId: string
  /** 画面に表示していた交換ポイント。指定された場合のみ一致を確認する。 */
  expectedExchangePoints?: number | undefined
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

export interface ExchangeResult {
  prizeId: string
  name: string
  grantedPoints: number
  /** 付与後の利用可能ポイント */
  balanceAfter: number
  expiresAt: Date
}

export async function exchangePrize(
  tx: PrismaTransactionClient,
  params: ExchangeParams,
): Promise<ExchangeResult> {
  const { userId, prizeId } = params

  // 行ロックを取ってから状態を読む。
  // 同時リクエストはここで待たされ、先行の結果を見てから判断できる。
  const prize = await lockPrizeForUpdate(tx, prizeId, userId)

  // 他人の当選商品も「存在しない」として扱う（ID の存在を推測させない）
  if (!prize) {
    throw errors.notFound('当選商品')
  }

  if (prize.status !== PrizeStatus.UNDECIDED) {
    throw errors.prizeNotUndecided()
  }

  // 表示とサーバーのズレを検出する。金額の根拠は常にサーバー側。
  if (
    params.expectedExchangePoints !== undefined &&
    params.expectedExchangePoints !== prize.exchange_points
  ) {
    throw errors.validation([
      {
        field: 'expectedExchangePoints',
        message: '交換ポイントが変更されています。画面を更新してからもう一度お試しください',
      },
    ])
  }

  const at = now()

  // --- 1. ポイントを発行する ---
  // sourceId に当選商品の ID を使う。台帳の UNIQUE により、
  // 同じ商品からの PRIZE_EXCHANGE 記帳は DB 側でも 1 件に制限される。
  const grant = await grantPoints(tx, {
    userId,
    amount: prize.exchange_points,
    pointType: PointType.FREE,
    txType: PointTxType.PRIZE_EXCHANGE,
    sourceType: 'USER_PRIZE',
    sourceId: prize.id,
  })

  // --- 2. 当選商品を交換済みにする（条件付き UPDATE + 件数検査） ---
  // 同時に 2 つのリクエストが来ても、遷移できるのは 1 つだけ。
  const updated = await tx.userPrize.updateMany({
    where: { id: prize.id, userId, status: PrizeStatus.UNDECIDED },
    data: {
      status: PrizeStatus.EXCHANGED,
      exchangedAt: at,
      exchangeLedgerEntryId: grant.ledgerEntryId,
    },
  })

  if (updated.count !== 1) {
    // 先に別のリクエストが交換（または発送申請）した。
    // ここで投げればトランザクションごと巻き戻り、ポイントは発行されない。
    throw errors.prizeNotUndecided()
  }

  // --- 3. 物理在庫を交換済みにする ---
  // これで再度オリパへ割り当てられる状態になる（運用判断で再販できる）。
  if (prize.inventory_id) {
    const inventoryUpdated = await tx.inventory.updateMany({
      where: { id: prize.inventory_id, status: InventoryStatus.WON },
      data: { status: InventoryStatus.EXCHANGED },
    })
    if (inventoryUpdated.count !== 1) {
      throw errors.conflict('在庫の状態が変化しています', { prizeId: prize.id })
    }
  }

  await writeAuditLog(
    {
      actorType: 'USER',
      actorId: userId,
      action: AUDIT_ACTIONS.PRIZE_EXCHANGED,
      targetType: AUDIT_TARGETS.USER_PRIZE,
      targetId: prize.id,
      before: { status: PrizeStatus.UNDECIDED },
      after: {
        status: PrizeStatus.EXCHANGED,
        grantedPoints: prize.exchange_points,
        ledgerEntryId: grant.ledgerEntryId,
      },
      ip: params.ip,
      userAgent: params.userAgent,
      requestId: params.requestId,
    },
    tx,
  )

  return {
    prizeId: prize.id,
    name: prize.name_snapshot,
    grantedPoints: prize.exchange_points,
    balanceAfter: grant.balanceAfter,
    expiresAt: grant.expiresAt,
  }
}
