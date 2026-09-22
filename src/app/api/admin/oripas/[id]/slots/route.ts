import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { allocateSlotsSchema, oripaIdParamsSchema } from '@/modules/oripa/schema.ts'
import { generateSlots } from '@/modules/oripa/slots.ts'

/**
 * 景品を割り当ててスロットを生成する（下書きのみ）。
 *
 * 生成結果のコミットハッシュとシードは、このレスポンスには含めない。
 * 公開処理（/publish）が同じ手順で再生成して保存する。
 */
export const runtime = 'nodejs'

export const POST = withIdempotentApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.ORIPA_WRITE,
    paramsSchema: oripaIdParamsSchema,
    bodySchema: allocateSlotsSchema,
    rateLimit: RATE_LIMIT_RULES.admin,
    idempotency: { scope: 'oripa_slots' },
  },
  async (ctx, tx) => {
    const result = await generateSlots(tx, ctx.params.id, ctx.body)

    // シードとコミットハッシュは公開時に確定させる。
    // ここで返すと、公開前に順序の手がかりを与えてしまう。
    return {
      totalSlots: result.totalSlots,
      perTier: result.perTier,
    }
  },
)
