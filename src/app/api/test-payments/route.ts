import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { createTestPaymentSchema } from '@/modules/payments/schema.ts'
import { createTestPayment } from '@/modules/payments/service.ts'

/**
 * テスト決済の作成。
 *
 * この時点ではポイントを付与しない（status は PENDING）。
 * 付与は「決済成功」への遷移時のみ行う。
 */
export const runtime = 'nodejs'

export const POST = withIdempotentApi(
  {
    auth: 'user',
    bodySchema: createTestPaymentSchema,
    rateLimit: RATE_LIMIT_RULES.mutation,
    idempotency: { scope: 'test_payment' },
    successStatus: 201,
  },
  async (ctx, tx, idempotencyKeyId) =>
    createTestPayment(
      tx,
      { userId: ctx.session.id, amountYen: ctx.body.amountYen },
      idempotencyKeyId,
    ),
)
