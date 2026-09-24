import { withApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { listPublicOripas } from '@/modules/oripa/queries.ts'

/**
 * 公開中オリパの一覧（未ログインでも参照できる）。
 *
 * draw_order・slot_order_seed を含めないことは
 * queries.ts の select で担保している。
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withApi({ auth: 'none', rateLimit: RATE_LIMIT_RULES.read }, async () => ({
  items: await listPublicOripas(),
}))
