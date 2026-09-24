import { errors } from '@/lib/api/errors.ts'
import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import {
  paymentIdParamsSchema,
  updateTestPaymentStatusSchema,
} from '@/modules/payments/schema.ts'
import { applyPaymentStatus } from '@/modules/payments/service.ts'

/**
 * テスト決済の状態を変更する（開発用）。
 *
 * 成功 / 失敗 / 取消し / 返金を再現する。
 * Webhook 経由と同じ applyPaymentStatus を通るため、
 * 「成功時のみポイントを付与する」規則はどちらの経路でも同じ。
 *
 * 自分の決済に対してのみ実行できる（所有者チェックはサービス層の前に行う）。
 */
export const runtime = 'nodejs'

export const POST = withIdempotentApi(
  {
    auth: 'user',
    paramsSchema: paymentIdParamsSchema,
    bodySchema: updateTestPaymentStatusSchema,
    rateLimit: RATE_LIMIT_RULES.mutation,
    idempotency: { scope: 'test_payment_status' },
  },
  async (ctx, tx) => {
    const payment = await tx.paymentTransaction.findUnique({
      where: { id: ctx.params.id },
      select: { id: true, userId: true },
    })

    // 他人の決済を操作できないようにする。
    // 存在しない場合と同じエラーにして、ID の存在を推測されないようにする。
    if (!payment || payment.userId !== ctx.session.id) {
      throw errors.notFound('決済')
    }

    return applyPaymentStatus(tx, payment.id, ctx.body.status, {
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })
  },
)
