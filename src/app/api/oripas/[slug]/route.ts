import { withApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { getPublicOripaDetail } from '@/modules/oripa/queries.ts'
import { oripaSlugParamsSchema } from '@/modules/oripa/schema.ts'

/**
 * オリパ詳細（ランク別の確率と当たり残数、公正性の検証情報）。
 *
 * 確率はサーバーで計算した値をそのまま返す。
 * クライアントが確率を計算・変更できる余地は作らない。
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withApi(
  {
    auth: 'none',
    paramsSchema: oripaSlugParamsSchema,
    rateLimit: RATE_LIMIT_RULES.read,
  },
  async (ctx) => getPublicOripaDetail(ctx.params.slug),
)
