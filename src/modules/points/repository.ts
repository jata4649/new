import { Prisma } from '@/generated/prisma/client.ts'
import { PointType } from '@/generated/prisma/enums.ts'
import type { ConsumptionStrategy } from '@/lib/config/points.ts'
import type { PrismaTransactionClient } from '@/server/db.ts'

/**
 * ポイントロットへの低レベルアクセス。
 *
 * Prisma の API では `FOR UPDATE` を表現できないため、
 * **このファイルに限って**生 SQL を使う。
 * 値は必ず Prisma.sql のパラメータとして渡し、文字列連結はしない。
 *
 * ビジネス判断はここに書かない（ledger.ts が行う）。
 */

export interface LockedLot {
  id: string
  pointType: PointType
  amountRemaining: number
  expiresAt: Date
}

/**
 * 消費順序の ORDER BY 句。
 *
 * ユーザー入力を混ぜないよう、戦略ごとの固定の SQL 片から選ぶ。
 * どの戦略でも最後は issued_at → id の順で並べ、結果が一意に定まるようにする
 * （同着があると、同じ入力でも消費されるロットが変わってしまう）。
 */
function orderByFor(strategy: ConsumptionStrategy): Prisma.Sql {
  switch (strategy) {
    case 'free_first':
      return Prisma.sql`ORDER BY (point_type = 'FREE') DESC, expires_at ASC, issued_at ASC, id ASC`
    case 'paid_first':
      return Prisma.sql`ORDER BY (point_type = 'PAID') DESC, expires_at ASC, issued_at ASC, id ASC`
    case 'expiry_only':
      return Prisma.sql`ORDER BY expires_at ASC, issued_at ASC, id ASC`
  }
}

/**
 * 消費対象のロットを、消費順序どおりに並べてロックする。
 *
 * - 期限切れのロットは対象外（バッチ未実行でも使わせない）
 * - `FOR UPDATE` により、同一ユーザーの並行リクエストは直列化される。
 *   ロックするのは自分の行だけなので、他ユーザーへの影響は無い。
 * - `NOWAIT` は使わない。同一ユーザーの二重送信は待たせて順に処理し、
 *   冪等性キーで二重実行を防ぐ方が、ユーザーから見た挙動が素直になる。
 */
export async function lockConsumableLots(
  tx: PrismaTransactionClient,
  userId: string,
  strategy: ConsumptionStrategy,
  now: Date,
): Promise<LockedLot[]> {
  const rows = await tx.$queryRaw<
    { id: string; point_type: PointType; amount_remaining: number; expires_at: Date }[]
  >`
    SELECT id, point_type, amount_remaining, expires_at
    FROM point_lots
    WHERE user_id = ${userId}
      AND amount_remaining > 0
      AND expires_at > ${now}
    ${orderByFor(strategy)}
    FOR UPDATE
  `

  return rows.map((row) => ({
    id: row.id,
    pointType: row.point_type,
    amountRemaining: row.amount_remaining,
    expiresAt: row.expires_at,
  }))
}

/**
 * ロットから指定量を引く。
 *
 * 条件付き UPDATE にしているため、ロックを取り損ねていた場合や
 * 計算がずれていた場合は 0 行更新となり、呼び出し側が検知できる。
 * CHECK 制約（0 <= amount_remaining <= amount_issued）と二重の防御。
 */
export async function decrementLot(
  tx: PrismaTransactionClient,
  lotId: string,
  amount: number,
  now: Date,
): Promise<boolean> {
  const updated = await tx.$executeRaw`
    UPDATE point_lots
    SET amount_remaining = amount_remaining - ${amount},
        exhausted_at = CASE
          WHEN amount_remaining - ${amount} = 0 THEN ${now}
          ELSE exhausted_at
        END
    WHERE id = ${lotId}
      AND amount_remaining >= ${amount}
  `
  return updated === 1
}

/** 返金・取消しで元のロットへ戻す（有効期限は元のまま） */
export async function incrementLot(
  tx: PrismaTransactionClient,
  lotId: string,
  amount: number,
): Promise<boolean> {
  const updated = await tx.$executeRaw`
    UPDATE point_lots
    SET amount_remaining = amount_remaining + ${amount},
        exhausted_at = NULL
    WHERE id = ${lotId}
      AND amount_remaining + ${amount} <= amount_issued
  `
  return updated === 1
}

export interface BalanceSnapshot {
  paidBalance: number
  freeBalance: number
}

/**
 * 口座残高を条件付きで増減する。
 *
 * 減算時は `WHERE paid_balance >= ?` を付けることで、
 * 残高不足を DB レベルでも弾く（CHECK 制約とあわせて三重の防御）。
 * 0 行更新なら呼び出し側が例外を投げる。
 */
export async function applyBalanceDelta(
  tx: PrismaTransactionClient,
  userId: string,
  paidDelta: number,
  freeDelta: number,
): Promise<BalanceSnapshot | null> {
  const rows = await tx.$queryRaw<{ paid_balance: number; free_balance: number }[]>`
    UPDATE point_accounts
    SET paid_balance = paid_balance + ${paidDelta},
        free_balance = free_balance + ${freeDelta},
        version = version + 1,
        updated_at = now()
    WHERE user_id = ${userId}
      AND paid_balance + ${paidDelta} >= 0
      AND free_balance + ${freeDelta} >= 0
    RETURNING paid_balance, free_balance
  `

  const row = rows[0]
  if (!row) return null

  return { paidBalance: row.paid_balance, freeBalance: row.free_balance }
}

/**
 * 実際に使えるポイント残高（期限切れを除く）。
 *
 * point_accounts の残高は失効バッチが走るまで期限切れ分を含んだままなので、
 * **ユーザーへ見せる残高と抽選の可否判定にはこちらを使う**。
 * point_accounts はキャッシュ・管理画面の一覧・整合性検証用。
 */
export async function getSpendableBalance(
  tx: PrismaTransactionClient,
  userId: string,
  now: Date,
): Promise<BalanceSnapshot> {
  const rows = await tx.$queryRaw<{ point_type: PointType; total: bigint }[]>`
    SELECT point_type, SUM(amount_remaining)::bigint AS total
    FROM point_lots
    WHERE user_id = ${userId}
      AND amount_remaining > 0
      AND expires_at > ${now}
    GROUP BY point_type
  `

  let paidBalance = 0
  let freeBalance = 0
  for (const row of rows) {
    if (row.point_type === PointType.PAID) paidBalance = Number(row.total)
    else freeBalance = Number(row.total)
  }

  return { paidBalance, freeBalance }
}

/** 失効処理の対象となるロットをロックして取得する（バッチ用） */
export async function lockExpiredLots(
  tx: PrismaTransactionClient,
  now: Date,
  limit: number,
): Promise<{ id: string; userId: string; pointType: PointType; amountRemaining: number }[]> {
  const rows = await tx.$queryRaw<
    { id: string; user_id: string; point_type: PointType; amount_remaining: number }[]
  >`
    SELECT id, user_id, point_type, amount_remaining
    FROM point_lots
    WHERE amount_remaining > 0
      AND expires_at <= ${now}
      AND expired_at IS NULL
    ORDER BY expires_at ASC, id ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    pointType: row.point_type,
    amountRemaining: row.amount_remaining,
  }))
}

/** ロットを失効させる（残高を 0 にし、失効日時を記録する） */
export async function markLotExpired(
  tx: PrismaTransactionClient,
  lotId: string,
  now: Date,
): Promise<boolean> {
  const updated = await tx.$executeRaw`
    UPDATE point_lots
    SET amount_remaining = 0,
        expired_at = ${now}
    WHERE id = ${lotId}
      AND expired_at IS NULL
  `
  return updated === 1
}
