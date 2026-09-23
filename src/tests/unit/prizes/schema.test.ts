import { describe, expect, it } from 'vitest'

import { exchangePrizeSchema, prizeListQuerySchema } from '@/modules/prizes/schema.ts'

/**
 * 当選商品の入力スキーマの単体テスト。
 *
 * ポイント交換は取消不可なので、
 * 「うっかり空リクエストを投げたら交換されていた」を成立させない。
 */

describe('exchangePrizeSchema', () => {
  it('confirm: true があれば受理する', () => {
    expect(exchangePrizeSchema.safeParse({ confirm: true }).success).toBe(true)
  })

  it('confirm が無ければ拒否する（取消不可の操作を既定で通さない）', () => {
    expect(exchangePrizeSchema.safeParse({}).success).toBe(false)
  })

  it('confirm: false を拒否する', () => {
    expect(exchangePrizeSchema.safeParse({ confirm: false }).success).toBe(false)
  })

  it('confirm が真偽値以外なら拒否する', () => {
    expect(exchangePrizeSchema.safeParse({ confirm: 'true' }).success).toBe(false)
    expect(exchangePrizeSchema.safeParse({ confirm: 1 }).success).toBe(false)
  })

  it('表示していた交換ポイントは任意。指定する場合は 0 以上の整数', () => {
    expect(
      exchangePrizeSchema.safeParse({ confirm: true, expectedExchangePoints: 0 }).success,
    ).toBe(true)
    expect(
      exchangePrizeSchema.safeParse({ confirm: true, expectedExchangePoints: -1 }).success,
    ).toBe(false)
    expect(
      exchangePrizeSchema.safeParse({ confirm: true, expectedExchangePoints: 1.5 }).success,
    ).toBe(false)
  })

  it('付与ポイントをリクエストで指定できない（金額の根拠はサーバー側）', () => {
    const result = exchangePrizeSchema.safeParse({
      confirm: true,
      grantedPoints: 999_999,
      amount: 999_999,
    })

    expect(result.success).toBe(true)
    if (result.success) {
      // 未知のキーは Zod が落とす
      expect(result.data).toEqual({ confirm: true })
    }
  })
})

describe('prizeListQuerySchema', () => {
  it('既定値を持つ', () => {
    const result = prizeListQuerySchema.parse({})
    expect(result.page).toBe(1)
    expect(result.perPage).toBe(24)
    expect(result.status).toBeUndefined()
  })

  it('状態で絞り込める', () => {
    expect(prizeListQuerySchema.parse({ status: 'UNDECIDED' }).status).toBe('UNDECIDED')
  })

  it('存在しない状態を拒否する', () => {
    expect(prizeListQuerySchema.safeParse({ status: 'NOPE' }).success).toBe(false)
  })

  it('取得件数の上限を超える指定を拒否する', () => {
    expect(prizeListQuerySchema.safeParse({ perPage: '1000' }).success).toBe(false)
  })
})
