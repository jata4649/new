import { z } from 'zod'

import { ALLOWED_DRAW_COUNTS } from '@/lib/config/draws.ts'

/**
 * 抽選の入力スキーマ。
 *
 * 【重要】ここに inventoryId / slotId / tierCode を受け取る項目は存在しない。
 *   要件「ブラウザから inventoryId や slotId を指定して抽選できないようにする」
 *   への対応は、検証で弾くのではなく**入力の形として持たない**ことで行う。
 *   受け取れる形があると、いつか誰かが使ってしまう。
 */

export const drawRequestSchema = z.object({
  /** 1 または 10。ALLOWED_DRAW_COUNTS が唯一の根拠。 */
  drawCount: z
    .number()
    .int()
    .refine((value) => (ALLOWED_DRAW_COUNTS as readonly number[]).includes(value), {
      message: `抽選口数は ${ALLOWED_DRAW_COUNTS.join(' または ')} のみ指定できます`,
    }),
  /**
   * 画面に表示していた 1 口価格。サーバー側の価格と一致しなければ拒否する。
   * 価格の根拠にはせず、「表示と実際がズレたまま購入させない」ためだけに使う。
   */
  expectedUnitPricePoints: z.number().int().min(1).optional(),
})

export type DrawRequestInput = z.infer<typeof drawRequestSchema>

export const drawIdParamsSchema = z.object({ id: z.string().min(1) })

export const drawHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(20),
})

export type DrawHistoryQuery = z.infer<typeof drawHistoryQuerySchema>

/** 管理画面の抽選履歴。調査に必要な絞り込みだけを持つ。 */
export const adminDrawListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  campaignSlug: z.string().trim().max(60).optional(),
  userEmail: z.string().trim().max(254).optional(),
})
