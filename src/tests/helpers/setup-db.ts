import { afterAll, beforeEach } from 'vitest'

import { loadDotEnvFiles } from '@/lib/config/dotenv.ts'

/**
 * 統合テスト・同時実行テスト用の DB セットアップ。
 *
 * 【重要】DATABASE_URL をテスト用へ差し替えてから @/server/db を読み込む
 *   サービス層は @/server/db の prisma シングルトンを使う。
 *   その解決より前に DATABASE_URL を上書きしないと、
 *   テストが**開発用 DB へ書き込んでしまう**。
 *   そのため、このファイルの先頭で環境変数を差し替え、
 *   動的 import で Prisma クライアントを生成する。
 *
 * 【重要】クリーンアップに DELETE を使わない
 *   台帳・監査ログ・抽選履歴は DB トリガで DELETE を拒否しているため、
 *   DELETE によるクリーンアップは必ず失敗する（それが正しい挙動）。
 *   TRUNCATE はトリガの対象外なので、クリーンアップには TRUNCATE を使う。
 */

loadDotEnvFiles()

function resolveTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL または DATABASE_URL を設定してください（テスト用 DB を指定します）',
    )
  }

  const looksLikeTestDb = /test/i.test(url)
  if (!looksLikeTestDb && process.env.ALLOW_DESTRUCTIVE_TESTS !== '1') {
    throw new Error(
      'テストは DB を TRUNCATE します。接続先の名前に "test" が含まれていません。\n' +
        `  接続先: ${url.replace(/:\/\/[^@]*@/, '://***@')}\n` +
        '  テスト専用 DB を TEST_DATABASE_URL に指定するか、' +
        '意図的な場合は ALLOW_DESTRUCTIVE_TESTS=1 を設定してください。',
    )
  }

  return url
}

// サービス層が同じ DB を見るよう、import より前に差し替える
process.env.DATABASE_URL = resolveTestDatabaseUrl()

// 環境変数の検証が通るよう、テストで未設定になりがちな値を補う
process.env.AUTH_SECRET ??= 'test-secret-'.padEnd(48, 'x')
process.env.SITE_BASIC_AUTH_USER ??= 'tester'
process.env.SITE_BASIC_AUTH_PASSWORD ??= 'tester-password'
// レート制限は Redis に依存するためテストでは無効化する
process.env.RATE_LIMIT_ENABLED = 'false'

const { prisma } = await import('@/server/db.ts')

/** サービス層と同じ接続を共有するクライアント */
export const testPrisma = prisma

/**
 * テーブルを空にする。
 * _prisma_migrations は残す（スキーマ状態を保つため）。
 */
export async function truncateAllTables(): Promise<void> {
  const tables = await testPrisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  `

  if (tables.length === 0) return

  const quoted = tables.map((t) => `"public"."${t.tablename}"`).join(', ')
  // RESTART IDENTITY でシーケンスも戻し、CASCADE で外部キーを無視して一括削除する
  await testPrisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`)
}

beforeEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await testPrisma.$disconnect()
})
