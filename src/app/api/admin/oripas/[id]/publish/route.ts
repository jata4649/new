import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { oripaIdParamsSchema, publishOripaSchema } from '@/modules/oripa/schema.ts'
import { publishOripa } from '@/modules/oripa/service.ts'

/**
 * オリパを公開する。
 *
 * 公開は不可逆（価格・口数・景品構成が凍結される）ため、
 * ORIPA_PUBLISH 権限を別に切り、冪等性キーも必須にしている。
 *
 * レスポンスにはコミットハッシュだけを含め、シードは絶対に返さない。
 */
export const runtime = 'nodejs'

export const POST = withIdempotentApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.ORIPA_PUBLISH,
    paramsSchema: oripaIdParamsSchema,
    bodySchema: publishOripaSchema,
    rateLimit: RATE_LIMIT_RULES.admin,
    idempotency: { scope: 'oripa_publish' },
  },
  async (ctx, tx) =>
    publishOripa(
      tx,
      ctx.params.id,
      { id: ctx.session.id },
      {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      },
    ),
)
