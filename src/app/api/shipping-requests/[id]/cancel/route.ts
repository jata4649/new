import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import {
  cancelShippingRequestSchema,
  shippingRequestIdParamsSchema,
} from '@/modules/shipping/schema.ts'
import { cancelShippingRequest } from '@/modules/shipping/service.ts'

/**
 * 発送申請の取消し（利用者本人）。
 *
 * 取り消せるのは発送準備に入る前（REQUESTED）だけ。
 * 取消しに成功すると当選商品は未選択へ戻り、改めて交換か再申請を選べる。
 */
export const runtime = 'nodejs'

export const POST = withIdempotentApi(
  {
    auth: 'user',
    paramsSchema: shippingRequestIdParamsSchema,
    bodySchema: cancelShippingRequestSchema,
    rateLimit: RATE_LIMIT_RULES.mutation,
    idempotency: { scope: 'shipping_cancel' },
  },
  async (ctx, tx) =>
    cancelShippingRequest(tx, {
      actorId: ctx.session.id,
      actorType: 'USER',
      shippingRequestId: ctx.params.id,
      reason: ctx.body.reason,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    }),
)
