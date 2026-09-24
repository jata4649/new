import { withAuthedApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { userIdParamsSchema } from '@/modules/users/schema.ts'
import { getUserDetail } from '@/modules/users/service.ts'

/** ユーザー詳細（管理画面）。 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.USER_READ,
    paramsSchema: userIdParamsSchema,
    rateLimit: RATE_LIMIT_RULES.admin,
  },
  async (ctx) => getUserDetail(ctx.params.id),
)
