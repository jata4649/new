import { withAuthedApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { getPaymentHistory } from '@/modules/points/queries.ts'

/** テスト決済の履歴。 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  { auth: 'user', rateLimit: RATE_LIMIT_RULES.read },
  async (ctx) => ({ items: await getPaymentHistory(ctx.session.id) }),
)
