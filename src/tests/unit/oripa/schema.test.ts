import { describe, expect, it } from 'vitest'

import {
  allocateSlotsSchema,
  createOripaSchema,
  MAX_TOTAL_SLOTS,
  suspendOripaSchema,
} from '@/modules/oripa/schema.ts'

/**
 * オリパ入力スキーマの単体テスト。
 *
 * 「口数の合計が総口数と一致しない構成は作れない」ことを、
 * API へ到達する前（Zod）で保証する。
 * 確率と景品数の不一致は、この時点で潰しておかないと
 * 公開直前まで気付けず、手戻りが大きい。
 */

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'sample-oripa',
    name: 'サンプルオリパ',
    pricePoints: 500,
    totalSlots: 100,
    salesStartAt: '2026-10-01T00:00:00.000Z',
    salesEndAt: '2026-10-31T00:00:00.000Z',
    effectSetKey: 'default',
    tiers: [
      { code: 'S', name: 'S賞', effectTier: 'JACKPOT', slotCount: 1, displayOrder: 0 },
      { code: 'A', name: 'A賞', effectTier: 'GOLD', slotCount: 9, displayOrder: 1 },
      { code: 'B', name: 'B賞', effectTier: 'NORMAL', slotCount: 90, displayOrder: 2 },
    ],
    ...overrides,
  }
}

describe('createOripaSchema', () => {
  it('口数の合計が総口数と一致していれば受理する', () => {
    const result = createOripaSchema.safeParse(baseInput())
    expect(result.success).toBe(true)
  })

  it('ランク口数の合計が総口数と一致しない場合は拒否する', () => {
    const result = createOripaSchema.safeParse(
      baseInput({
        tiers: [
          { code: 'S', name: 'S賞', effectTier: 'JACKPOT', slotCount: 1, displayOrder: 0 },
          { code: 'A', name: 'A賞', effectTier: 'GOLD', slotCount: 9, displayOrder: 1 },
        ],
      }),
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'tiers')).toBe(true)
    }
  })

  it('ランクコードの重複を拒否する', () => {
    const result = createOripaSchema.safeParse(
      baseInput({
        totalSlots: 100,
        tiers: [
          { code: 'S', name: 'S賞', effectTier: 'JACKPOT', slotCount: 50, displayOrder: 0 },
          { code: 'S', name: 'S賞(2)', effectTier: 'GOLD', slotCount: 50, displayOrder: 1 },
        ],
      }),
    )

    expect(result.success).toBe(false)
  })

  it('販売終了日時が販売開始日時以前なら拒否する', () => {
    const result = createOripaSchema.safeParse(
      baseInput({
        salesStartAt: '2026-10-31T00:00:00.000Z',
        salesEndAt: '2026-10-01T00:00:00.000Z',
      }),
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'salesEndAt')).toBe(true)
    }
  })

  it('1 口価格 0 を拒否する（無料配布は抽選の体をなさない）', () => {
    expect(createOripaSchema.safeParse(baseInput({ pricePoints: 0 })).success).toBe(false)
  })

  it('小数の価格・口数を拒否する（金額はすべて整数）', () => {
    expect(createOripaSchema.safeParse(baseInput({ pricePoints: 500.5 })).success).toBe(false)
    expect(createOripaSchema.safeParse(baseInput({ totalSlots: 100.5 })).success).toBe(false)
  })

  it('総口数の上限を超える構成を拒否する', () => {
    const over = MAX_TOTAL_SLOTS + 1
    const result = createOripaSchema.safeParse(
      baseInput({
        totalSlots: over,
        tiers: [
          { code: 'A', name: 'A賞', effectTier: 'GOLD', slotCount: over, displayOrder: 0 },
        ],
      }),
    )
    expect(result.success).toBe(false)
  })

  it('スラッグに大文字・記号を許さない', () => {
    expect(createOripaSchema.safeParse(baseInput({ slug: 'Sample_Oripa' })).success).toBe(false)
    expect(createOripaSchema.safeParse(baseInput({ slug: 'sample oripa' })).success).toBe(false)
  })

  it('perUserLimit は未指定・null のどちらも上限なしとして受理する', () => {
    expect(
      createOripaSchema.safeParse(baseInput({ perUserLimit: null }).valueOf()).success,
    ).toBe(true)
    expect(createOripaSchema.safeParse(baseInput()).success).toBe(true)
  })
})

describe('allocateSlotsSchema', () => {
  it('inventoryIds を省略した場合は空配列になる（汎用景品だけで埋める構成）', () => {
    const result = allocateSlotsSchema.safeParse({
      allocations: [{ tierCode: 'B', genericPrizeCode: 'GENERIC-POINT-100' }],
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.allocations[0]?.inventoryIds).toEqual([])
    }
  })

  it('allocations が空なら拒否する', () => {
    expect(allocateSlotsSchema.safeParse({ allocations: [] }).success).toBe(false)
  })
})

describe('suspendOripaSchema', () => {
  it('理由が短すぎる場合は拒否する（監査ログに残す値なので）', () => {
    expect(suspendOripaSchema.safeParse({ reason: '中止' }).success).toBe(false)
    expect(suspendOripaSchema.safeParse({ reason: '在庫確認のため一時停止' }).success).toBe(
      true,
    )
  })
})
