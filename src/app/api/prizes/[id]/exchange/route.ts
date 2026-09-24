import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { exchangePrizeSchema, prizeIdParamsSchema } from '@/modules/prizes/schema.ts'
import { exchangePrize } from '@/modules/prizes/service.ts'

/**
 * 当選商品のポイント交換。
 *
 * **取消不可**の操作なので、
 *  - 本文で confirm: true を必須にする（誤送信で成立させない）
 *  - 冪等性キーを必須にする（再送で二重に付与されない）
 * の両方を要求する。
 */
export const runtime = 'nodejs'

export const POST = withIdempotentApi(
  {
    auth: 'user',
    paramsSchema: prizeIdParamsSchema,
    bodySchema: exchangePrizeSchema,
    rateLimit: RATE_LIMIT_RULES.mutation,
    idempotency: { scope: 'prize_exchange' },
  },
  async (ctx, tx) =>
    exchangePrize(tx, {
      userId: ctx.session.id,
      prizeId: ctx.params.id,
      expectedExchangePoints: ctx.body.expectedExchangePoints,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    }),
)
