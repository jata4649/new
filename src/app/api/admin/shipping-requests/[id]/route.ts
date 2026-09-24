import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import {
  shippingRequestIdParamsSchema,
  updateShippingStatusSchema,
} from '@/modules/shipping/schema.ts'
import { updateShippingStatus } from '@/modules/shipping/service.ts'

/**
 * 発送状態の更新（管理画面）。
 *
 * 遷移は service 側の表で制限している（巻き戻しは作らない）。
 * SHIPPED へ進めるときは配送業者と追跡番号を必須にする。
 * 取消しは別経路（/api/admin/shipping-requests/:id/cancel）で扱う。
 */
export const runtime = 'nodejs'

export const PATCH = withIdempotentApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.SHIPPING_UPDATE,
    paramsSchema: shippingRequestIdParamsSchema,
    bodySchema: updateShippingStatusSchema,
    rateLimit: RATE_LIMIT_RULES.admin,
    idempotency: { scope: 'shipping_status_update' },
  },
  async (ctx, tx) =>
    updateShippingStatus(tx, {
      adminId: ctx.session.id,
      shippingRequestId: ctx.params.id,
      input: ctx.body,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    }),
)
