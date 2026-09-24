import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import {
  adminCancelShippingSchema,
  shippingRequestIdParamsSchema,
} from '@/modules/shipping/schema.ts'
import { cancelShippingRequest } from '@/modules/shipping/service.ts'

/**
 * 発送申請の取消し（管理者）。
 *
 * 利用者は申請直後しか取り消せないが、管理者は梱包中まで取り消せる。
 * 検品で欠品・破損が判明することがあるため。
 * 理由は必須で、監査ログに残す。
 */
export const runtime = 'nodejs'

export const POST = withIdempotentApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.SHIPPING_UPDATE,
    paramsSchema: shippingRequestIdParamsSchema,
    bodySchema: adminCancelShippingSchema,
    rateLimit: RATE_LIMIT_RULES.admin,
    idempotency: { scope: 'shipping_admin_cancel' },
  },
  async (ctx, tx) =>
    cancelShippingRequest(tx, {
      actorId: ctx.session.id,
      actorType: 'ADMIN',
      shippingRequestId: ctx.params.id,
      reason: ctx.body.reason,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    }),
)
