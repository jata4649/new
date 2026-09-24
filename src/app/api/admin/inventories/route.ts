import { withAuthedApi, withIdempotentApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { createInventorySchema, inventoryListQuerySchema } from '@/modules/inventory/schema.ts'
import { createInventory, listInventories } from '@/modules/inventory/service.ts'

/** カード在庫の一覧と登録。 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.INVENTORY_READ,
    querySchema: inventoryListQuerySchema,
    rateLimit: RATE_LIMIT_RULES.admin,
  },
  async (ctx) => listInventories(ctx.query),
)

export const POST = withIdempotentApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.INVENTORY_WRITE,
    bodySchema: createInventorySchema,
    rateLimit: RATE_LIMIT_RULES.admin,
    idempotency: { scope: 'inventory_create' },
    successStatus: 201,
  },
  async (ctx, tx) =>
    createInventory(
      tx,
      ctx.body,
      { id: ctx.session.id },
      {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      },
    ),
)
