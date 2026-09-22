import { describe, expect, it } from 'vitest'

import {
  addPoints,
  AmountRangeError,
  formatOdds,
  formatPercent,
  formatPoints,
  INT_MAX,
  multiplyPoints,
  nonNegativePoints,
  points,
  ratio,
  subPoints,
  sumPoints,
  yen,
  yenToPoints,
} from '@/lib/money/points.ts'

/**
 * 要件「金額・ポイント・口数はすべて整数」「浮動小数点で金額計算をしない」の検証。
 * ここが崩れると全システムの金銭計算が信用できなくなるため、境界値を厚く確認する。
 */

describe('points', () => {
  it('整数を受け入れる', () => {
    expect(points(0)).toBe(0)
    expect(points(500)).toBe(500)
    expect(points(-500)).toBe(-500) // 台帳の消費は負値で表現する
  })

  it('小数を拒否する', () => {
    expect(() => points(1.5)).toThrow(AmountRangeError)
    expect(() => points(0.1 + 0.2)).toThrow(AmountRangeError)
  })

  it('NaN / Infinity を拒否する', () => {
    expect(() => points(Number.NaN)).toThrow(AmountRangeError)
    expect(() => points(Number.POSITIVE_INFINITY)).toThrow(AmountRangeError)
  })

  it('DB の Int 範囲を超える値を拒否する', () => {
    expect(() => points(INT_MAX + 1)).toThrow(AmountRangeError)
    expect(() => points(-2_147_483_649)).toThrow(AmountRangeError)
  })
})

describe('nonNegativePoints', () => {
  it('負値を拒否する（残高・価格に使う）', () => {
    expect(nonNegativePoints(0)).toBe(0)
    expect(() => nonNegativePoints(-1)).toThrow(AmountRangeError)
  })
})

describe('四則演算', () => {
  it('加算・減算ができる', () => {
    expect(addPoints(points(1_000), points(500))).toBe(1_500)
    expect(subPoints(points(1_000), points(500))).toBe(500)
  })

  it('10 連の合計を正しく計算する', () => {
    expect(multiplyPoints(points(500), 10)).toBe(5_000)
  })

  it('合計がオーバーフローしたら例外を投げる（黙って壊れない）', () => {
    expect(() => multiplyPoints(points(INT_MAX), 2)).toThrow(AmountRangeError)
    expect(() => addPoints(points(INT_MAX), points(1))).toThrow(AmountRangeError)
  })

  it('配列の合計を計算できる', () => {
    expect(sumPoints([points(100), points(200), points(300)])).toBe(600)
    expect(sumPoints([])).toBe(0)
  })
})

describe('yenToPoints', () => {
  it('1 円 = 1 ポイントで換算する', () => {
    expect(yenToPoints(yen(1_000))).toBe(1_000)
    expect(yenToPoints(yen(0))).toBe(0)
  })
})

describe('ratio / formatPercent', () => {
  it('分母 0 を拒否する', () => {
    expect(() => ratio(1, 0)).toThrow(AmountRangeError)
  })

  it('当選確率を丸め誤差なく整形する', () => {
    // S 賞 1 口 / 総口数 5000 口 = 0.020%
    expect(formatPercent(ratio(1, 5_000))).toBe('0.020%')
    // D 賞 4875 口 / 5000 口 = 97.500%
    expect(formatPercent(ratio(4_875, 5_000))).toBe('97.500%')
    expect(formatPercent(ratio(1, 3), 3)).toBe('33.333%')
    expect(formatPercent(ratio(1, 1))).toBe('100.000%')
    expect(formatPercent(ratio(0, 5_000))).toBe('0.000%')
  })

  it('小数桁数 0 を指定できる', () => {
    expect(formatPercent(ratio(1, 2), 0)).toBe('50%')
  })

  it('0.1 + 0.2 問題の影響を受けない', () => {
    // 浮動小数点で計算すると 30.000000000000004% になりうる組み合わせ
    expect(formatPercent(ratio(3, 10))).toBe('30.000%')
  })
})

describe('formatOdds', () => {
  it('1/n 形式で表示する', () => {
    expect(formatOdds(ratio(1, 5_000))).toBe('1/5,000')
    expect(formatOdds(ratio(4, 5_000))).toBe('1/1,250')
  })

  it('当選口数 0 なら 0 を返す', () => {
    expect(formatOdds(ratio(0, 5_000))).toBe('0')
  })
})

describe('表示用フォーマット', () => {
  it('3 桁区切りで整形する', () => {
    expect(formatPoints(1_234_567)).toBe('1,234,567 P')
  })
})
