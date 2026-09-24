import type { PrizeStatus } from '@/generated/prisma/enums.ts'
import type { PrismaTransactionClient } from '@/server/db.ts'

/**
 * 発送まわりの低レベルアクセス。
 *
 * Prisma の API では `FOR UPDATE` を表現できないため、
 * **このファイルに限って**生 SQL を使う。
 * 値は必ずパラメータとして渡し、文字列連結はしない。
 *
 * ビジネス判断はここに書かない（service.ts が行う）。
 */

export interface LockedPrizeForShipping {
  id: string
  status: PrizeStatus
  shippable: boolean
  name_snapshot: string
  inventory_id: string | null
}

/**
 * 発送申請の対象となる当選商品を、まとめて行ロックつきで取得する。
 *
 * ■ なぜロックが要るのか
 *   申請処理は「状態を確認 → 申請を作る → 商品を SHIPPING_REQUESTED にする」
 *   の順で進む。ロックなしだと、同時に来た 2 つのリクエストが**どちらも**
 *   「まだ UNDECIDED だ」と読んでしまう。
 *
 *   実際の二重申請は `shipping_request_items` の部分 UNIQUE（INV-7）が
 *   止めるので壊れたデータは入らないが、利用者へ返るのは一意制約違反、
 *   つまり 500 になってしまう。ロックを取れば後続は先行の確定後を読むので、
 *   「すでに申請済みです（409）」と正しく伝えられる。
 *   ポイント交換で同じ問題を実測しており、同時実行テストで検証する。
 *
 * ■ ID 昇順でロックする
 *   複数商品をまとめて申請できるため、2 つのリクエストが
 *   別々の順序でロックを取るとデッドロックしうる。
 *   `ORDER BY id` を付けて、全リクエストで取得順を揃える。
 *
 * ■ SKIP LOCKED は使わない
 *   抽選と違い「空いているものを取る」処理ではない。
 *   利用者が指定した商品そのものを扱うので、待って確定状態を見る。
 */
export async function lockPrizesForShipping(
  tx: PrismaTransactionClient,
  prizeIds: string[],
  userId: string,
): Promise<LockedPrizeForShipping[]> {
  if (prizeIds.length === 0) return []

  return tx.$queryRaw<LockedPrizeForShipping[]>`
    SELECT id, status::text AS status, shippable, name_snapshot, inventory_id
    FROM user_prizes
    WHERE id = ANY(${prizeIds}::text[])
      AND user_id = ${userId}
    ORDER BY id
    FOR UPDATE
  `
}

export interface LockedShippingRequest {
  id: string
  status: string
  user_id: string
}

/**
 * 発送申請を行ロックつきで取得する。
 *
 * 取消しと管理者の状態更新が同時に走ると、
 * 「取り消したのに発送された」「発送したのに取り消された」が起きうる。
 * 双方がこのロックを通ることで、後から来たほうが確定状態を見て判断できる。
 */
export async function lockShippingRequestForUpdate(
  tx: PrismaTransactionClient,
  requestId: string,
): Promise<LockedShippingRequest | null> {
  const rows = await tx.$queryRaw<LockedShippingRequest[]>`
    SELECT id, status::text AS status, user_id
    FROM shipping_requests
    WHERE id = ${requestId}
    FOR UPDATE
  `
  return rows[0] ?? null
}
