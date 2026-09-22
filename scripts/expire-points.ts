import { loadDotEnvFiles } from '../src/lib/config/dotenv.ts'

/**
 * ポイントの有効期限切れ処理（日次バッチ）。
 *
 *   pnpm points:expire
 *   pnpm points:expire --dry-run   … 対象件数を数えるだけ
 *
 * 【重要】このバッチが遅れても、失効済みポイントは使えない。
 *   残高の参照と消費は常に expires_at > now() で絞っているため。
 *   このバッチは台帳への記帳と口座キャッシュの同期を行う。
 *
 * 終了コード: 処理中にエラーが起きたら 1
 */

loadDotEnvFiles()

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')

  const { prisma } = await import('../src/server/db.ts')
  const { expirePoints } = await import('../src/modules/points/expiry.ts')

  try {
    if (dryRun) {
      const rows = await prisma.$queryRaw<{ count: bigint; total: bigint | null }[]>`
        SELECT count(*)::bigint AS count, SUM(amount_remaining)::bigint AS total
        FROM point_lots
        WHERE amount_remaining > 0
          AND expires_at <= now()
          AND expired_at IS NULL
      `
      const summary = rows[0] ?? { count: 0n, total: 0n }
      console.log(
        `失効対象: ロット ${Number(summary.count)} 件 / ` +
          `${Number(summary.total ?? 0).toLocaleString('ja-JP')} ポイント`,
      )
      console.log('(--dry-run のため、実際の処理は行いませんでした)')
      return
    }

    const result = await expirePoints()

    console.log('ポイント失効処理が完了しました')
    console.log(`  処理したロット: ${result.processedLots} 件`)
    console.log(`  失効ポイント:   ${result.expiredPoints.toLocaleString('ja-JP')} P`)
    console.log(`  対象ユーザー:   ${result.affectedUsers} 名`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error('ポイント失効処理に失敗しました:', error)
  process.exit(1)
})
