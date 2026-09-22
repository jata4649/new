import { withApi } from '@/lib/api/with-api.ts'
import { prisma } from '@/server/db.ts'

/**
 * ヘルスチェック。
 *
 * 監視から叩かれる前提のため、認証を要求しない代わりに
 * **内部情報を一切返さない**（バージョン・接続先・エラー詳細を含めない）。
 * DB へ到達できるかどうかの真偽値だけを返す。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withApi({ auth: 'none' }, async () => {
  let databaseReachable = false
  try {
    await prisma.$queryRaw`SELECT 1`
    databaseReachable = true
  } catch {
    // 失敗の詳細は返さない。ログには withApi 経由で残らないため、ここでは真偽値のみ扱う。
    databaseReachable = false
  }

  return {
    status: databaseReachable ? ('ok' as const) : ('degraded' as const),
    database: databaseReachable,
  }
})
