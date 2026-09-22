import { describe, expect, it } from 'vitest'

import {
  buildSlotOrderCommitment,
  secureCompare,
  secureRandomInt,
  secureShuffle,
  secureShuffledSequence,
  sha256Hex,
} from '@/lib/crypto/random.ts'

/**
 * 抽選の公正性は、この乱数ユーティリティの正しさに依存する。
 * 「偏っていないこと」「順列であること」を機械的に検証する。
 */

describe('secureRandomInt', () => {
  it('0 以上 max 未満の整数を返す', () => {
    for (let i = 0; i < 1_000; i++) {
      const value = secureRandomInt(10)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(10)
    }
  })

  it('max が 0 以下なら例外を投げる', () => {
    expect(() => secureRandomInt(0)).toThrow(RangeError)
    expect(() => secureRandomInt(-1)).toThrow(RangeError)
  })

  it('モジュロバイアスが無く、ほぼ一様に分布する', () => {
    const buckets = 7 // 2 の冪でない値の方がバイアスが出やすい
    const trials = 70_000
    const counts = new Array<number>(buckets).fill(0)

    for (let i = 0; i < trials; i++) {
      const value = secureRandomInt(buckets)
      counts[value] = (counts[value] ?? 0) + 1
    }

    const expected = trials / buckets
    // カイ二乗検定。自由度 6 の 99.9% 点は約 22.46。
    const chiSquare = counts.reduce(
      (sum, observed) => sum + (observed - expected) ** 2 / expected,
      0,
    )
    expect(chiSquare).toBeLessThan(22.46)
  })
})

describe('secureShuffle', () => {
  it('元の配列を変更しない', () => {
    const original = [1, 2, 3, 4, 5]
    const copy = [...original]
    secureShuffle(original)
    expect(original).toEqual(copy)
  })

  it('要素の多重集合が保存される（欠落・重複が起きない）', () => {
    const original = Array.from({ length: 500 }, (_, i) => i)
    const shuffled = secureShuffle(original)
    expect(shuffled).toHaveLength(original.length)
    expect([...shuffled].sort((a, b) => a - b)).toEqual(original)
  })

  it('空配列・単一要素でも壊れない', () => {
    expect(secureShuffle([])).toEqual([])
    expect(secureShuffle(['a'])).toEqual(['a'])
  })

  it('各要素が各位置へほぼ均等に現れる', () => {
    // 3 要素の並びを多数回試行し、6 通りの順列が均等に出ることを確認する
    const permutationCounts = new Map<string, number>()
    const trials = 60_000

    for (let i = 0; i < trials; i++) {
      const key = secureShuffle(['a', 'b', 'c']).join('')
      permutationCounts.set(key, (permutationCounts.get(key) ?? 0) + 1)
    }

    expect(permutationCounts.size).toBe(6)

    const expected = trials / 6
    const chiSquare = [...permutationCounts.values()].reduce(
      (sum, observed) => sum + (observed - expected) ** 2 / expected,
      0,
    )
    // 自由度 5 の 99.9% 点は約 20.52
    expect(chiSquare).toBeLessThan(20.52)
  })
})

describe('secureShuffledSequence', () => {
  it('1..n の順列を返す（スロットの drawOrder に使える）', () => {
    const n = 5_000
    const sequence = secureShuffledSequence(n)

    expect(sequence).toHaveLength(n)
    expect(new Set(sequence).size).toBe(n)
    expect(Math.min(...sequence)).toBe(1)
    expect(Math.max(...sequence)).toBe(n)
  })

  it('毎回異なる順列になる（固定シードではない）', () => {
    const a = secureShuffledSequence(100).join(',')
    const b = secureShuffledSequence(100).join(',')
    expect(a).not.toBe(b)
  })

  it('n が不正なら例外を投げる', () => {
    expect(() => secureShuffledSequence(0)).toThrow(RangeError)
    expect(() => secureShuffledSequence(1.5)).toThrow(RangeError)
  })
})

describe('buildSlotOrderCommitment', () => {
  const base = {
    campaignId: 'camp_1',
    serverSeed: 'seed-abc',
    tierCodesInDrawOrder: ['D', 'C', 'B', 'A', 'S'],
  }

  it('同じ入力からは同じハッシュが得られる（検証可能性）', () => {
    expect(buildSlotOrderCommitment(base)).toBe(buildSlotOrderCommitment(base))
  })

  it('景品構成を 1 つでも差し替えるとハッシュが変わる', () => {
    const tampered = {
      ...base,
      tierCodesInDrawOrder: ['D', 'C', 'B', 'A', 'D'], // S 賞を D 賞へ差し替え
    }
    expect(buildSlotOrderCommitment(tampered)).not.toBe(buildSlotOrderCommitment(base))
  })

  it('順序を入れ替えただけでもハッシュが変わる', () => {
    const reordered = {
      ...base,
      tierCodesInDrawOrder: ['S', 'A', 'B', 'C', 'D'],
    }
    expect(buildSlotOrderCommitment(reordered)).not.toBe(buildSlotOrderCommitment(base))
  })

  it('シードが違えばハッシュが変わる', () => {
    expect(buildSlotOrderCommitment({ ...base, serverSeed: 'other' })).not.toBe(
      buildSlotOrderCommitment(base),
    )
  })
})

describe('secureCompare', () => {
  it('同一文字列で true を返す', () => {
    expect(secureCompare('secret-token', 'secret-token')).toBe(true)
  })

  it('異なる文字列で false を返す', () => {
    expect(secureCompare('secret-token', 'secret-tokeN')).toBe(false)
  })

  it('長さが違っても例外を投げずに false を返す', () => {
    expect(secureCompare('short', 'much-longer-value')).toBe(false)
  })
})

describe('sha256Hex', () => {
  it('既知のベクタと一致する', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})
