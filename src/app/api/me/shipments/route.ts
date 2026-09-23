import { withAuthedApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { listUserShipments } from '@/modules/shipping/queries.ts'
import { shipmentListQuerySchema } from '@/modules/shipping/schema.ts'

/** 自分の発送申請一覧。宛先は申請時点のスナップショットを返す。 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  {
    auth: 'user',
    querySchema: shipmentListQuerySchema,
    rateLimit: RATE_LIMIT_RULES.read,
  },
  async (ctx) => listUserShipments(ctx.session.id, ctx.query),
)
