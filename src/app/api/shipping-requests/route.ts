import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { createShippingRequestSchema } from '@/modules/shipping/schema.ts'
import { requestShipping } from '@/modules/shipping/service.ts'

/**
 * 発送申請。
 *
 * 複数の当選商品を 1 件の申請にまとめられる。
 * 申請が成立すると当選商品は SHIPPING_REQUESTED になり、
 * 取り消すまでポイント交換はできなくなる。
 *
 * 冪等性キーを必須にしているので、再送しても申請は 1 件しか作られない。
 */
export const runtime = 'nodejs'

export const POST = withIdempotentApi(
  {
    auth: 'user',
    bodySchema: createShippingRequestSchema,
    rateLimit: RATE_LIMIT_RULES.mutation,
    idempotency: { scope: 'shipping_request' },
    successStatus: 201,
  },
  async (ctx, tx, idempotencyKeyId) =>
    requestShipping(tx, {
      userId: ctx.session.id,
      prizeIds: ctx.body.prizeIds,
      addressId: ctx.body.addressId,
      idempotencyKeyId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    }),
)
