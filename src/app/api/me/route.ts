import { withAuthedApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { getMyProfile } from '@/modules/users/me.ts'

/** ログイン中ユーザー自身のプロフィール。 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  { auth: 'user', rateLimit: RATE_LIMIT_RULES.read },
  async (ctx) => getMyProfile(ctx.session.id),
)
