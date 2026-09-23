import { z } from 'zod'

import { PrizeStatus } from '@/generated/prisma/enums.ts'

/**
 * 当選商品の入力スキーマ。
 *
 * ポイント交換は**取消不可**なので、確認の意思表示を必須にしている。
 * 「誤ってボタンを押した」で交換が成立しないよう、
 * 画面の確認ダイアログだけでなく API の入力としても要求する。
 */

export const exchangePrizeSchema = z.object({
  /** 取消不可であることを理解したうえでの実行 */
  confirm: z.literal(true, { message: '交換の確認が必要です' }),
  /**
   * 画面に表示していた交換ポイント。
   * サーバー側の値と違えば拒否する（古い画面のまま交換させないため）。
   */
  expectedExchangePoints: z.number().int().min(0).optional(),
})

export type ExchangePrizeInput = z.infer<typeof exchangePrizeSchema>

export const prizeIdParamsSchema = z.object({ id: z.string().min(1) })

export const prizeListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(24),
  status: z.enum(PrizeStatus).optional(),
})

export type PrizeListQuery = z.infer<typeof prizeListQuerySchema>
