import { loadDotEnvFiles } from '../src/lib/config/dotenv.ts'

/**
 * 期限切れレコードの掃除（日次バッチ）。
 *
 *   pnpm cleanup:expired
 *   pnpm cleanup:expired --dry-run   … 対象件数を数えるだけ
 *
 * 消すのはセッションと冪等性キーだけ。
 * 台帳・抽選・監査ログには触れない（追記専用で、DB トリガが DELETE を拒否する）。
 *
 * 【重要】このバッチが遅れても、利用者から見た挙動は変わらない。
 *   期限切れセッションは毎リクエストの有効性確認で弾かれ、
 *   期限切れ冪等性キーは expires_at で絞って再利用できないようにしている。
 *   行数を抑えるための掃除であり、整合性の担保ではない。
 *
 * 終了コード: 処理中にエラーが起きたら 1
 */

loadDotEnvFiles()

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')

  const { prisma } = await import('../src/server/db.ts')
  const { cleanupExpiredRecords, IDEMPOTENCY_GRACE_DAYS } = await import(
    '../src/modules/maintenance/cleanup.ts'
  )

  try {
    const result = await cleanupExpiredRecords(prisma, { dryRun })

    const verb = dryRun ? '対象' : '削除しました'
    console.log(
      `期限切れセッション: ${result.expiredSessions.toLocaleString('ja-JP')} 件 ${verb}`,
    )
    console.log(
      `期限切れ冪等性キー: ${result.expiredIdempotencyKeys.toLocaleString('ja-JP')} 件 ${verb}` +
        `（期限から ${IDEMPOTENCY_GRACE_DAYS} 日以上経過したもの）`,
    )

    if (dryRun) {
      console.log('(--dry-run のため、実際の削除は行いませんでした)')
    } else if (result.truncated) {
      console.log('上限に達したため打ち切りました。次回の実行で残りを処理します。')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error('掃除に失敗しました:', error)
  process.exitCode = 1
})
