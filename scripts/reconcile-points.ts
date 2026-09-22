import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '../src/generated/prisma/client.ts'
import { loadDotEnvFiles } from '../src/lib/config/dotenv.ts'

/**
 * ポイント整合性の検証バッチ（読み取り専用）。
 *
 * 検証する不変条件:
 *   INV-1  Σ(point_ledger_entries.amount) == point_accounts の合計残高
 *   INV-2  Σ(point_lots.amount_remaining) == point_accounts の合計残高
 *   INV-3  0 <= point_lots.amount_remaining <= amount_issued
 *   INV-補 Σ(point_lot_consumptions.amount) == (amount_issued - amount_remaining)
 *
 * 台帳が真実なので、ズレが見つかった場合に直すべきは point_accounts 側である。
 * このスクリプトは検出のみを行い、自動修復はしない
 * （原因を確認せずに残高を書き換えるのは危険なため）。
 *
 * 使い方:
 *   pnpm points:reconcile           … 検証して結果を出力する
 *   pnpm points:reconcile --json    … CI 用に JSON で出力する
 *
 * 終了コード: 不整合が 1 件でもあれば 1（CI で失敗させられる）
 */

loadDotEnvFiles()

interface Discrepancy {
  userId: string
  kind: 'LEDGER_VS_ACCOUNT' | 'LOTS_VS_ACCOUNT' | 'LOT_RANGE' | 'CONSUMPTION_MISMATCH'
  expected: number
  actual: number
  detail: string
}

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL が設定されていません')
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

/** INV-1: 台帳の合計と口座残高の一致 */
async function checkLedgerVsAccount(prisma: PrismaClient): Promise<Discrepancy[]> {
  const rows = await prisma.$queryRaw<
    { user_id: string; ledger_total: bigint; account_total: bigint }[]
  >`
    SELECT
      a.user_id,
      COALESCE(SUM(e.amount), 0)::bigint      AS ledger_total,
      (a.paid_balance + a.free_balance)::bigint AS account_total
    FROM point_accounts a
    LEFT JOIN point_ledger_entries e ON e.user_id = a.user_id
    GROUP BY a.user_id, a.paid_balance, a.free_balance
    HAVING COALESCE(SUM(e.amount), 0) <> (a.paid_balance + a.free_balance)
  `

  return rows.map((row) => ({
    userId: row.user_id,
    kind: 'LEDGER_VS_ACCOUNT' as const,
    expected: Number(row.ledger_total),
    actual: Number(row.account_total),
    detail: '台帳の合計と口座残高が一致しません（口座残高キャッシュが古い可能性）',
  }))
}

/** INV-2: ロット残高の合計と口座残高の一致（期限切れ未処理分も含めて突合する） */
async function checkLotsVsAccount(prisma: PrismaClient): Promise<Discrepancy[]> {
  const rows = await prisma.$queryRaw<
    { user_id: string; lot_total: bigint; account_total: bigint }[]
  >`
    SELECT
      a.user_id,
      COALESCE(SUM(l.amount_remaining), 0)::bigint AS lot_total,
      (a.paid_balance + a.free_balance)::bigint    AS account_total
    FROM point_accounts a
    LEFT JOIN point_lots l ON l.user_id = a.user_id
    GROUP BY a.user_id, a.paid_balance, a.free_balance
    HAVING COALESCE(SUM(l.amount_remaining), 0) <> (a.paid_balance + a.free_balance)
  `

  return rows.map((row) => ({
    userId: row.user_id,
    kind: 'LOTS_VS_ACCOUNT' as const,
    expected: Number(row.lot_total),
    actual: Number(row.account_total),
    detail:
      'ロット残高の合計と口座残高が一致しません' +
      '（期限切れバッチが未実行の場合もここに出る）',
  }))
}

/** INV-3: ロット残高の範囲（DB の CHECK 制約と二重化） */
async function checkLotRange(prisma: PrismaClient): Promise<Discrepancy[]> {
  const rows = await prisma.$queryRaw<
    { id: string; user_id: string; amount_issued: number; amount_remaining: number }[]
  >`
    SELECT id, user_id, amount_issued, amount_remaining
    FROM point_lots
    WHERE amount_remaining < 0 OR amount_remaining > amount_issued
  `

  return rows.map((row) => ({
    userId: row.user_id,
    kind: 'LOT_RANGE' as const,
    expected: row.amount_issued,
    actual: row.amount_remaining,
    detail: `ロット ${row.id} の残高が範囲外です`,
  }))
}

/** 消費明細の合計とロットの減少分の一致 */
async function checkConsumptions(prisma: PrismaClient): Promise<Discrepancy[]> {
  const rows = await prisma.$queryRaw<
    { id: string; user_id: string; consumed: bigint; decreased: number }[]
  >`
    SELECT
      l.id,
      l.user_id,
      COALESCE(SUM(c.amount), 0)::bigint       AS consumed,
      (l.amount_issued - l.amount_remaining)   AS decreased
    FROM point_lots l
    LEFT JOIN point_lot_consumptions c ON c.lot_id = l.id
    GROUP BY l.id, l.user_id, l.amount_issued, l.amount_remaining
    HAVING COALESCE(SUM(c.amount), 0) <> (l.amount_issued - l.amount_remaining)
  `

  return rows.map((row) => ({
    userId: row.user_id,
    kind: 'CONSUMPTION_MISMATCH' as const,
    expected: row.decreased,
    actual: Number(row.consumed),
    detail:
      `ロット ${row.id} の減少分と消費明細の合計が一致しません` +
      '（期限切れ処理は消費明細を作らないため、失効後はここに出ることがある）',
  }))
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json')
  const prisma = createClient()

  try {
    const discrepancies = [
      ...(await checkLedgerVsAccount(prisma)),
      ...(await checkLotsVsAccount(prisma)),
      ...(await checkLotRange(prisma)),
      ...(await checkConsumptions(prisma)),
    ]

    const accountCount = await prisma.pointAccount.count()

    if (asJson) {
      console.log(
        JSON.stringify({ accountCount, discrepancyCount: discrepancies.length, discrepancies }),
      )
    } else {
      console.log(`ポイント整合性チェック: 口座 ${accountCount} 件を検証しました`)
      if (discrepancies.length === 0) {
        console.log('不整合は見つかりませんでした')
      } else {
        console.error(`\n不整合が ${discrepancies.length} 件見つかりました:`)
        for (const d of discrepancies) {
          console.error(
            `  [${d.kind}] user=${d.userId} 期待値=${d.expected} 実際=${d.actual}\n    ${d.detail}`,
          )
        }
        console.error(
          '\n台帳が真実です。口座残高キャッシュの再計算を検討してください。' +
            '自動修復は行いません（原因の確認が先です）。',
        )
      }
    }

    process.exitCode = discrepancies.length === 0 ? 0 : 1
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error('整合性チェックに失敗しました:', error)
  process.exit(1)
})
