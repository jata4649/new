import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { oripaIdParamsSchema, revealSeedSchema } from '@/modules/oripa/schema.ts'
import { revealSlotOrderSeed } from '@/modules/oripa/service.ts'

/**
 * シードの公開（リビール）。
 *
 * 販売終了後にのみ実行できる。公開するとユーザー向けの詳細画面に
 * シードが出て、第三者がコミットハッシュを検証できるようになる。
 *
 * **一度公開したら取り消せない**ので、確認の意思表示（confirm: true）と
 * 冪等性キーの両方を要求する。
 */
export const runtime = 'nodejs'

export const POST = withIdempotentApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.ORIPA_PUBLISH,
    paramsSchema: oripaIdParamsSchema,
    bodySchema: revealSeedSchema,
    rateLimit: RATE_LIMIT_RULES.admin,
    idempotency: { scope: 'oripa_seed_reveal' },
  },
  async (ctx, tx) =>
    revealSlotOrderSeed(
      tx,
      ctx.params.id,
      { id: ctx.session.id },
      { ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId },
    ),
)
