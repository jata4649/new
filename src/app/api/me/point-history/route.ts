import { withAuthedApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { pointHistoryQuerySchema } from '@/modules/payments/schema.ts'
import { getPointHistory } from '@/modules/points/queries.ts'

/** ポイント履歴（台帳の閲覧）。 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  {
    auth: 'user',
    querySchema: pointHistoryQuerySchema,
    rateLimit: RATE_LIMIT_RULES.read,
  },
  async (ctx) => getPointHistory(ctx.session.id, ctx.query),
)
