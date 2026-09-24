import { withAuthedApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { listDrawsForAdmin } from '@/modules/draws/queries.ts'
import { adminDrawListQuerySchema } from '@/modules/draws/schema.ts'

/**
 * 抽選履歴（管理画面）。
 *
 * 問い合わせ対応のための参照専用。
 * スロット ID と抽選順は返さない（次に出るものを逆算されないため）。
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.DRAW_READ,
    querySchema: adminDrawListQuerySchema,
    rateLimit: RATE_LIMIT_RULES.admin,
  },
  async (ctx) => listDrawsForAdmin(ctx.query),
)
