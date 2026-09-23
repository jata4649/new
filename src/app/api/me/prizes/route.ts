import { withAuthedApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { listUserPrizes } from '@/modules/prizes/queries.ts'
import { prizeListQuerySchema } from '@/modules/prizes/schema.ts'

/** 自分の当選商品一覧。未選択（UNDECIDED）を先頭に返す。 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  {
    auth: 'user',
    querySchema: prizeListQuerySchema,
    rateLimit: RATE_LIMIT_RULES.read,
  },
  async (ctx) => listUserPrizes(ctx.session.id, ctx.query),
)
