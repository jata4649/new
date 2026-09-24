import { describe, expect, it } from 'vitest'

import {
  ALLOWED_DRAW_COUNTS,
  isAllowedDrawCount,
  MAX_SLOTS_PER_DRAW,
} from '@/lib/config/draws.ts'
import { drawHistoryQuerySchema, drawRequestSchema } from '@/modules/draws/schema.ts'

/**
 * 抽選入力の単体テスト。
 *
 * ここで守りたいのは「クライアントが抽選対象を指定できない」こと。
 * 検証で弾くのではなく**入力の形として持たない**設計なので、
 * 余計なキーが素通りしていないことも確認する。
 */

describe('drawRequestSchema', () => {
  it('許可された口数を受理する', () => {
    for (const count of ALLOWED_DRAW_COUNTS) {
      expect(drawRequestSchema.safeParse({ drawCount: count }).success).toBe(true)
    }
  })

  it('許可されていない口数を拒否する', () => {
    for (const count of [0, 2, 3, 5, 9, 11, 100, -1]) {
      expect(drawRequestSchema.safeParse({ drawCount: count }).success).toBe(false)
    }
  })

  it('小数の口数を拒否する', () => {
    expect(drawRequestSchema.safeParse({ drawCount: 1.5 }).success).toBe(false)
  })

  it('口数が無ければ拒否する（既定値を作らない）', () => {
    expect(drawRequestSchema.safeParse({}).success).toBe(false)
  })

  it('slotId / inventoryId を指定しても結果に残らない', () => {
    const result = drawRequestSchema.safeParse({
      drawCount: 1,
      slotId: 'slot_00000000',
      inventoryId: 'inv_00000000',
      tierCode: 'S',
    })

    expect(result.success).toBe(true)
    if (result.success) {
      // Zod は未知のキーを落とす。サービス層へは口数しか渡らない。
      expect(result.data).toEqual({ drawCount: 1 })
      expect(Object.keys(result.data)).not.toContain('slotId')
      expect(Object.keys(result.data)).not.toContain('inventoryId')
    }
  })

  it('表示価格は任意。指定する場合は 1 以上の整数', () => {
    expect(drawRequestSchema.safeParse({ drawCount: 1 }).success).toBe(true)
    expect(
      drawRequestSchema.safeParse({ drawCount: 1, expectedUnitPricePoints: 500 }).success,
    ).toBe(true)
    expect(
      drawRequestSchema.safeParse({ drawCount: 1, expectedUnitPricePoints: 0 }).success,
    ).toBe(false)
    expect(
      drawRequestSchema.safeParse({ drawCount: 1, expectedUnitPricePoints: 1.5 }).success,
    ).toBe(false)
  })
})

describe('ALLOWED_DRAW_COUNTS', () => {
  it('1 回と 10 連を含む（要件）', () => {
    expect(ALLOWED_DRAW_COUNTS).toContain(1)
    expect(ALLOWED_DRAW_COUNTS).toContain(10)
  })

  it('isAllowedDrawCount が配列と一致する', () => {
    expect(isAllowedDrawCount(1)).toBe(true)
    expect(isAllowedDrawCount(10)).toBe(true)
    expect(isAllowedDrawCount(2)).toBe(false)
  })

  it('MAX_SLOTS_PER_DRAW が最大の口数と一致する', () => {
    expect(MAX_SLOTS_PER_DRAW).toBe(Math.max(...ALLOWED_DRAW_COUNTS))
  })
})

describe('drawHistoryQuerySchema', () => {
  it('既定値を持つ', () => {
    const result = drawHistoryQuerySchema.parse({})
    expect(result.page).toBe(1)
    expect(result.perPage).toBe(20)
  })

  it('文字列のクエリパラメータを数値へ変換する', () => {
    const result = drawHistoryQuerySchema.parse({ page: '3', perPage: '50' })
    expect(result.page).toBe(3)
    expect(result.perPage).toBe(50)
  })

  it('取得件数の上限を超える指定を拒否する（重いクエリを投げさせない）', () => {
    expect(drawHistoryQuerySchema.safeParse({ perPage: '1000' }).success).toBe(false)
  })
})
