import { describe, expect, it } from 'vitest'

import { EffectTier } from '@/generated/prisma/enums.ts'
import { strongestTier, TIER_PRESENTATION } from '@/lib/effects/tiers.ts'

/**
 * 演出設定の単体テスト。
 *
 * 演出は結果が確定したあとの表示にすぎないが、
 * 「どのランクにも設定がある」ことは保証しておく。
 * 設定が欠けたランクが出ると、演出中に例外が出て結果が見えなくなるため。
 */

const ALL_TIERS = Object.values(EffectTier)

describe('TIER_PRESENTATION', () => {
  it('すべての演出ランクに設定がある', () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_PRESENTATION[tier]).toBeDefined()
    }
  })

  it('すべてのランクに読み上げ用のラベルがある（色だけに頼らない）', () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_PRESENTATION[tier].srLabel.length).toBeGreaterThan(0)
    }
  })

  it('上位ランクほど演出が長い', () => {
    const order: EffectTier[] = [
      EffectTier.NORMAL,
      EffectTier.BLUE,
      EffectTier.GOLD,
      EffectTier.RAINBOW,
      EffectTier.JACKPOT,
    ]
    const delays = order.map((tier) => TIER_PRESENTATION[tier].revealDelayMs)
    const sorted = [...delays].sort((a, b) => a - b)
    expect(delays).toEqual(sorted)
  })

  it('10 連をすべて最上位で引いても演出が長くなりすぎない', () => {
    // スキップできるとはいえ、待たされ続ける設計にはしない
    const worstCase = TIER_PRESENTATION.JACKPOT.revealDelayMs * 10
    expect(worstCase).toBeLessThanOrEqual(8_000)
  })

  it('画面を揺らすのは最上位だけ', () => {
    const shaking = ALL_TIERS.filter((tier) => TIER_PRESENTATION[tier].shake)
    expect(shaking).toEqual([EffectTier.JACKPOT])
  })
})

describe('strongestTier', () => {
  it('最も強いランクを返す', () => {
    expect(strongestTier([EffectTier.NORMAL, EffectTier.GOLD, EffectTier.BLUE])).toBe(
      EffectTier.GOLD,
    )
    expect(strongestTier([EffectTier.JACKPOT, EffectTier.RAINBOW])).toBe(EffectTier.JACKPOT)
  })

  it('1 件だけならそれを返す', () => {
    expect(strongestTier([EffectTier.BLUE])).toBe(EffectTier.BLUE)
  })

  it('空なら null を返す', () => {
    expect(strongestTier([])).toBeNull()
  })
})
