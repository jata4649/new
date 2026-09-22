import { withAuthedApi, withIdempotentApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { createOripaSchema, oripaListQuerySchema } from '@/modules/oripa/schema.ts'
import { createOripa, listOripasForAdmin } from '@/modules/oripa/service.ts'

/** オリパの一覧と作成（下書き）。 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.ORIPA_READ,
    querySchema: oripaListQuerySchema,
    rateLimit: RATE_LIMIT_RULES.admin,
  },
  async (ctx) => listOripasForAdmin(ctx.query),
)

export const POST = withIdempotentApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.ORIPA_WRITE,
    bodySchema: createOripaSchema,
    rateLimit: RATE_LIMIT_RULES.admin,
    idempotency: { scope: 'oripa_create' },
    successStatus: 201,
  },
  async (ctx, tx) =>
    createOripa(
      tx,
      ctx.body,
      { id: ctx.session.id },
      {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      },
    ),
)
