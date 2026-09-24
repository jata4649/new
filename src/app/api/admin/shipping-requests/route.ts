import { withAuthedApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { listShipmentsForAdmin } from '@/modules/shipping/queries.ts'
import { adminShipmentListQuerySchema } from '@/modules/shipping/schema.ts'

/**
 * 発送申請一覧（管理画面）。
 *
 * 古い申請から並べる。待たせている順に処理するのが運用上も正しい。
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.SHIPPING_READ,
    querySchema: adminShipmentListQuerySchema,
    rateLimit: RATE_LIMIT_RULES.admin,
  },
  async (ctx) => listShipmentsForAdmin(ctx.query),
)
