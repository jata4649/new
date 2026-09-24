import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { drawRequestSchema } from '@/modules/draws/schema.ts'
import { executeDraw } from '@/modules/draws/service.ts'
import { oripaSlugParamsSchema } from '@/modules/oripa/schema.ts'

/**
 * 抽選の実行。
 *
 * ■ 冪等性キーが必須
 *   通信が切れて同じキーで再送されても、記録済みの結果がそのまま返る
 *   （`Idempotency-Replayed: true`）。再抽選もポイントの二重消費も起きない。
 *
 * ■ 入力は口数だけ
 *   slotId / inventoryId / tierCode を受け取る項目はスキーマに存在しない。
 *   どのスロットを引くかはサーバーが決める。
 *
 * ■ レスポンスが返る時点で結果は DB に確定している
 *   クライアントはこれを受け取ってから演出を再生する（Phase 6）。
 *   演出を閉じてもリロードしても、結果は /api/draws/:id で取り直せる。
 */
export const runtime = 'nodejs'

export const POST = withIdempotentApi(
  {
    auth: 'user',
    paramsSchema: oripaSlugParamsSchema,
    bodySchema: drawRequestSchema,
    rateLimit: RATE_LIMIT_RULES.draw,
    idempotency: { scope: 'draw' },
  },
  async (ctx, tx, idempotencyKeyId) =>
    executeDraw(tx, {
      userId: ctx.session.id,
      slug: ctx.params.slug,
      drawCount: ctx.body.drawCount,
      expectedUnitPricePoints: ctx.body.expectedUnitPricePoints,
      idempotencyKeyId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    }),
)
