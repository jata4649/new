import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { oripaIdParamsSchema, suspendOripaSchema } from '@/modules/oripa/schema.ts'
import { resumeOripa, suspendOripa } from '@/modules/oripa/service.ts'

/**
 * 販売の緊急停止と再開。
 *
 * POST   = 停止（理由必須）
 * DELETE = 停止の解除（再開。こちらも理由を残す）
 *
 * どちらも監査ログへ理由つきで記録される。
 * 停止しても、すでに確定した抽選結果には影響しない。
 */
export const runtime = 'nodejs'

export const POST = withIdempotentApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.ORIPA_SUSPEND,
    paramsSchema: oripaIdParamsSchema,
    bodySchema: suspendOripaSchema,
    rateLimit: RATE_LIMIT_RULES.admin,
    idempotency: { scope: 'oripa_suspend' },
  },
  async (ctx, tx) =>
    suspendOripa(
      tx,
      ctx.params.id,
      ctx.body.reason,
      { id: ctx.session.id },
      {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      },
    ),
)

export const DELETE = withIdempotentApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.ORIPA_SUSPEND,
    paramsSchema: oripaIdParamsSchema,
    bodySchema: suspendOripaSchema,
    rateLimit: RATE_LIMIT_RULES.admin,
    idempotency: { scope: 'oripa_resume' },
  },
  async (ctx, tx) =>
    resumeOripa(
      tx,
      ctx.params.id,
      ctx.body.reason,
      { id: ctx.session.id },
      {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      },
    ),
)
