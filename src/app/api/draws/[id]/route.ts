import { withAuthedApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { getDrawDetail } from '@/modules/draws/queries.ts'
import { drawIdParamsSchema } from '@/modules/draws/schema.ts'

/**
 * 抽選結果の再取得。
 *
 * リロード・通信断・演出の中断から復帰するための入口。
 * 本人の結果だけを返す（他人の ID を指定しても 404）。
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  {
    auth: 'user',
    paramsSchema: drawIdParamsSchema,
    rateLimit: RATE_LIMIT_RULES.read,
  },
  async (ctx) => getDrawDetail(ctx.params.id, ctx.session.id),
)
