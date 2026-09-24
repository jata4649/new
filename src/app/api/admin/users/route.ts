import { withAuthedApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { userListQuerySchema } from '@/modules/users/schema.ts'
import { listUsers } from '@/modules/users/service.ts'

/** ユーザー一覧（管理画面）。 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.USER_READ,
    querySchema: userListQuerySchema,
    rateLimit: RATE_LIMIT_RULES.admin,
  },
  async (ctx) => listUsers(ctx.query),
)
