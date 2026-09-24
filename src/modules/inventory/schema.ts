import { z } from 'zod'

import { CardCondition, InventoryStatus } from '@/generated/prisma/enums.ts'

/**
 * カード在庫の入力スキーマ。
 *
 * 在庫は**物理個体ごと**に 1 行。同じカードが 3 枚あれば 3 行になる。
 * これにより「同じ物理在庫を複数のオリパへ重複割当できない」ことを
 * DB の UNIQUE 制約で保証できる（INV-5）。
 */

/** 金額は円単位の整数。小数を受け取らない。 */
const yenAmount = z.number().int().min(0).max(100_000_000)

export const createInventorySchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, '在庫コードを入力してください')
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, '在庫コードは半角英数字とハイフン・アンダースコアのみ'),
  cardTitle: z.string().trim().min(1, 'カードタイトルを入力してください').max(120),
  cardName: z.string().trim().min(1, 'カード名を入力してください').max(120),
  cardNumber: z.string().trim().max(40).optional(),
  rarity: z.string().trim().max(20).optional(),
  condition: z.enum(CardCondition).default(CardCondition.NEAR_MINT),

  gradingCompany: z.string().trim().max(60).optional(),
  gradingScore: z.string().trim().max(20).optional(),
  gradingCertNo: z.string().trim().max(60).optional(),

  costPriceYen: yenAmount.optional(),
  referencePriceYen: yenAmount.optional(),
  /** ポイント交換価格。抽選時にスナップショットされる。 */
  exchangePoints: z.number().int().min(0).max(2_000_000_000),

  storageLocation: z.string().trim().max(60).optional(),
  frontImageKey: z.string().trim().max(200).optional(),
  backImageKey: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1_000).optional(),

  // --- 古物営業法の帳簿要件（後付けできないため最初から記録する） ---
  acquisitionSource: z.string().trim().max(120).optional(),
  acquiredFrom: z.string().trim().max(120).optional(),
  acquiredAt: z.iso.datetime().optional(),
})

export type CreateInventoryInput = z.infer<typeof createInventorySchema>

/**
 * 在庫の更新。
 * 在庫コードは識別子なので変更できない（変更したい場合は新規登録する）。
 */
export const updateInventorySchema = createInventorySchema
  .omit({ code: true })
  .partial()
  .extend({
    /**
     * 状態の手動変更。
     * DAMAGED / LOST は理由の入力を必須にする（アプリ層で検証）。
     */
    status: z.enum(InventoryStatus).optional(),
    reason: z.string().trim().max(500).optional(),
  })

export type UpdateInventoryInput = z.infer<typeof updateInventorySchema>

export const inventoryListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  /** 在庫コード・カード名の部分一致 */
  q: z.string().trim().max(120).optional(),
  status: z.enum(InventoryStatus).optional(),
  rarity: z.string().trim().max(20).optional(),
})

export type InventoryListQuery = z.infer<typeof inventoryListQuerySchema>

export const inventoryIdParamsSchema = z.object({ id: z.string().min(1) })
