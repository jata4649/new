import { withAuthedApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { getPointSummary } from '@/modules/points/queries.ts'

/**
 * 保有ポイント。
 *
 * spendable（実際に使える残高）と、有効期限が近い順のロット一覧を返す。
 * 口座キャッシュ（cached）も返すが、表示には spendable を使うこと。
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  { auth: 'user', rateLimit: RATE_LIMIT_RULES.read },
  async (ctx) => getPointSummary(ctx.session.id),
)
