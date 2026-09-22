import { z } from 'zod'

import { CampaignStatus, EffectTier } from '@/generated/prisma/enums.ts'

/**
 * オリパの入力スキーマ。
 *
 * 価格・口数はすべて整数。総口数の上限を設けているのは、
 * スロット生成がメモリ上で順列を作るため（docs/06-draw-algorithm.md）。
 */

/** 総口数の上限。これを超える場合はスロット生成の方式を見直すこと。 */
export const MAX_TOTAL_SLOTS = 100_000

export const prizeTierInputSchema = z.object({
  /** 'S' / 'A' / 'B' など。表示順の決定にも使う。 */
  code: z
    .string()
    .trim()
    .min(1, 'ランクコードを入力してください')
    .max(8)
    .regex(/^[A-Za-z0-9]+$/, 'ランクコードは半角英数字のみ'),
  name: z.string().trim().min(1, 'ランク名を入力してください').max(60),
  effectTier: z.enum(EffectTier),
  slotCount: z.number().int().min(1, '口数は 1 以上にしてください').max(MAX_TOTAL_SLOTS),
  displayOrder: z.number().int().min(0).max(1_000),
})

export type PrizeTierInput = z.infer<typeof prizeTierInputSchema>

export const createOripaSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(3, 'スラッグは 3 文字以上にしてください')
      .max(60)
      .regex(/^[a-z0-9-]+$/, 'スラッグは半角小文字・数字・ハイフンのみ'),
    name: z.string().trim().min(1, '名称を入力してください').max(120),
    description: z.string().trim().max(2_000).optional(),
    thumbnailKey: z.string().trim().max(200).optional(),
    pricePoints: z
      .number()
      .int()
      .min(1, '1 口価格は 1 ポイント以上にしてください')
      .max(1_000_000),
    totalSlots: z
      .number()
      .int()
      .min(1, '総口数は 1 以上にしてください')
      .max(
        MAX_TOTAL_SLOTS,
        `総口数は ${MAX_TOTAL_SLOTS.toLocaleString('ja-JP')} 以下にしてください`,
      ),
    /** null / 未指定なら上限なし */
    perUserLimit: z.number().int().min(1).max(MAX_TOTAL_SLOTS).nullish(),
    salesStartAt: z.iso.datetime(),
    salesEndAt: z.iso.datetime(),
    effectSetKey: z.string().trim().max(60).default('default'),
    tiers: z
      .array(prizeTierInputSchema)
      .min(1, '景品ランクを 1 つ以上設定してください')
      .max(20),
  })
  .refine((value) => new Date(value.salesEndAt) > new Date(value.salesStartAt), {
    message: '販売終了日時は販売開始日時より後にしてください',
    path: ['salesEndAt'],
  })
  .refine(
    (value) => {
      const uniqueCodes = new Set(value.tiers.map((tier) => tier.code))
      return uniqueCodes.size === value.tiers.length
    },
    { message: 'ランクコードが重複しています', path: ['tiers'] },
  )
  .refine(
    (value) => value.tiers.reduce((sum, tier) => sum + tier.slotCount, 0) === value.totalSlots,
    {
      message: '景品ランクの口数の合計が総口数と一致していません',
      path: ['tiers'],
    },
  )

export type CreateOripaInput = z.infer<typeof createOripaSchema>

/**
 * 下書きの更新。
 * DRAFT のときだけ使える（サービス層で検証）。
 */
export const updateOripaSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2_000).optional(),
  thumbnailKey: z.string().trim().max(200).optional(),
  pricePoints: z.number().int().min(1).max(1_000_000).optional(),
  perUserLimit: z.number().int().min(1).max(MAX_TOTAL_SLOTS).nullish(),
  salesStartAt: z.iso.datetime().optional(),
  salesEndAt: z.iso.datetime().optional(),
  effectSetKey: z.string().trim().max(60).optional(),
})

export type UpdateOripaInput = z.infer<typeof updateOripaSchema>

/**
 * 景品割当。ランクごとに、使用する在庫 ID または汎用景品を指定する。
 *
 * 指定した件数がランクの口数と一致しない場合は拒否する。
 */
export const allocateSlotsSchema = z.object({
  allocations: z
    .array(
      z.object({
        tierCode: z.string().trim().min(1).max(8),
        /** 物理在庫の ID。汎用景品を使う場合は空配列にする。 */
        inventoryIds: z.array(z.string().min(1)).max(MAX_TOTAL_SLOTS).default([]),
        /** 残りを埋める汎用景品のコード。null なら在庫だけで埋める。 */
        genericPrizeCode: z.string().trim().max(64).nullish(),
      }),
    )
    .min(1)
    .max(20),
})

export type AllocateSlotsInput = z.infer<typeof allocateSlotsSchema>

export const publishOripaSchema = z.object({
  /** 販売開始日時が未来なら SCHEDULED、現在以前なら ACTIVE になる */
  confirm: z.literal(true, { message: '公開の確認が必要です' }),
})

export const suspendOripaSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, '理由は 5 文字以上で入力してください')
    .max(500, '理由は 500 文字以内で入力してください'),
})

export const oripaListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(CampaignStatus).optional(),
  q: z.string().trim().max(120).optional(),
})

export type OripaListQuery = z.infer<typeof oripaListQuerySchema>

export const oripaIdParamsSchema = z.object({ id: z.string().min(1) })
export const oripaSlugParamsSchema = z.object({ slug: z.string().min(1).max(60) })
