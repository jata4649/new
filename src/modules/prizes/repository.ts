import type { PrizeStatus } from '@/generated/prisma/enums.ts'
import type { PrismaTransactionClient } from '@/server/db.ts'

/**
 * 当選商品への低レベルアクセス。
 *
 * Prisma の API では `FOR UPDATE` を表現できないため、
 * **このファイルに限って**生 SQL を使う。
 * 値は必ずパラメータとして渡し、文字列連結はしない。
 *
 * ビジネス判断はここに書かない（service.ts が行う）。
 */

export interface LockedPrize {
  id: string
  status: PrizeStatus
  exchange_points: number
  name_snapshot: string
  inventory_id: string | null
}

/**
 * 当選商品を行ロックつきで取得する。
 *
 * ■ なぜロックが要るのか
 *
 *   交換処理は「状態を確認 → ポイントを発行 → 状態を更新」の順で進む。
 *   ロックなしだと、同時に来た 2 つのリクエストが**どちらも**
 *   「まだ UNDECIDED だ」と読んでしまい、2 つともポイント発行へ進む。
 *
 *   そこは台帳の (source_type, source_id, tx_type) UNIQUE が止めるので
 *   二重付与にはならない。ただし利用者へ返るのは一意制約違反、
 *   つまり「予期せぬエラー（500）」になってしまう。
 *   本当は「すでに交換済みです（409）」と伝えたい。
 *
 *   ここで `FOR UPDATE` を取ると、後続のリクエストは先行がコミットするまで
 *   待ち、そのあと確定後の状態を読む。結果として正しい 409 を返せる。
 *
 * ■ ロックするのは自分の 1 行だけ
 *   他の利用者の当選商品には影響しない。
 *   `NOWAIT` は使わない。待たせて順に処理するほうが挙動が素直になる。
 */
export async function lockPrizeForUpdate(
  tx: PrismaTransactionClient,
  prizeId: string,
  userId: string,
): Promise<LockedPrize | null> {
  const rows = await tx.$queryRaw<LockedPrize[]>`
    SELECT id, status::text AS status, exchange_points, name_snapshot, inventory_id
    FROM user_prizes
    WHERE id = ${prizeId}
      AND user_id = ${userId}
    FOR UPDATE
  `
  return rows[0] ?? null
}
