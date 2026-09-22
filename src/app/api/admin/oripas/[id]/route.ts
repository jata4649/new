import { withAuthedApi, withIdempotentApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { oripaIdParamsSchema, updateOripaSchema } from '@/modules/oripa/schema.ts'
import { checkPublishableById, updateOripaDraft } from '@/modules/oripa/service.ts'

/** オリパの公開条件チェックと下書き更新。 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.ORIPA_READ,
    paramsSchema: oripaIdParamsSchema,
    rateLimit: RATE_LIMIT_RULES.admin,
  },
  // 公開条件のチェックリストを返す。管理画面がそのまま表示する。
  async (ctx) => checkPublishableById(ctx.params.id),
)

export const PATCH = withIdempotentApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.ORIPA_WRITE,
    paramsSchema: oripaIdParamsSchema,
    bodySchema: updateOripaSchema,
    rateLimit: RATE_LIMIT_RULES.admin,
    idempotency: { scope: 'oripa_update' },
  },
  async (ctx, tx) =>
    updateOripaDraft(
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
