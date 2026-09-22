import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { adjustPointsSchema } from '@/modules/payments/schema.ts'
import { adjustUserPoints } from '@/modules/points/admin.ts'
import { userIdParamsSchema } from '@/modules/users/schema.ts'

/**
 * 管理者によるポイント調整。
 *
 * 理由は必須（Zod・DB の CHECK 制約の二重）。
 * 残高を直接書き換えず、必ず台帳へ ADJUSTMENT として記帳する。
 */
export const runtime = 'nodejs'

export const POST = withIdempotentApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.USER_ADJUST_POINTS,
    paramsSchema: userIdParamsSchema,
    bodySchema: adjustPointsSchema,
    rateLimit: RATE_LIMIT_RULES.admin,
    idempotency: { scope: 'point_adjustment' },
  },
  async (ctx, tx, idempotencyKeyId) =>
    adjustUserPoints(
      tx,
      {
        userId: ctx.params.id,
        amount: ctx.body.amount,
        reason: ctx.body.reason,
        // 台帳の一意制約はリクエスト単位。実行者 ID を入れてはいけない。
        requestId: idempotencyKeyId,
      },
      { id: ctx.session.id },
      { ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId },
    ),
)
