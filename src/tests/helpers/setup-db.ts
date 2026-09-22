import { PrismaPg } from '@prisma/adapter-pg'
import { afterAll, beforeEach } from 'vitest'

import { PrismaClient } from '@/generated/prisma/client.ts'
import { loadDotEnvFiles } from '@/lib/config/dotenv.ts'

/**
 * 統合テスト・同時実行テスト用の DB セットアップ。
 *
 * 【重要】クリーンアップに DELETE を使わない
 *   台帳・監査ログ・抽選履歴は DB トリガで DELETE を拒否しているため、
 *   DELETE によるクリーンアップは必ず失敗する（それが正しい挙動）。
 *   TRUNCATE はトリガの対象外なので、テストのクリーンアップには TRUNCATE を使う。
 *
 * 接続先は TEST_DATABASE_URL（無ければ DATABASE_URL）。
 * 開発 DB を誤って消さないよう、URL に 'test' を含まない場合は明示的な
 * 許可フラグ（ALLOW_DESTRUCTIVE_TESTS=1）が無い限り実行を中止する。
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

const connectionString = resolveTestDatabaseUrl()

export const testPrisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
})

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
