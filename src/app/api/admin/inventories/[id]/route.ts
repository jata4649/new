import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { inventoryIdParamsSchema, updateInventorySchema } from '@/modules/inventory/schema.ts'
import { updateInventory } from '@/modules/inventory/service.ts'

/** カード在庫の更新。 */
export const runtime = 'nodejs'

export const PATCH = withIdempotentApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.INVENTORY_WRITE,
    paramsSchema: inventoryIdParamsSchema,
    bodySchema: updateInventorySchema,
    rateLimit: RATE_LIMIT_RULES.admin,
    idempotency: { scope: 'inventory_update' },
  },
  async (ctx, tx) =>
    updateInventory(
      tx,
      ctx.params.id,
      ctx.body,
      { id: ctx.session.id },
      {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      },
    ),
)
