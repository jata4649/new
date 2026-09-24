import { withAuthedApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { listUserDraws } from '@/modules/draws/queries.ts'
import { drawHistoryQuerySchema } from '@/modules/draws/schema.ts'

/** 自分の抽選履歴。 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  {
    auth: 'user',
    querySchema: drawHistoryQuerySchema,
    rateLimit: RATE_LIMIT_RULES.read,
  },
  async (ctx) => listUserDraws(ctx.session.id, ctx.query),
)
