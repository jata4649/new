/**
 * ポイント・金額の整数演算。
 *
 * 要件: 「金額、ポイント、口数はすべて整数で管理する」「浮動小数点で金額計算をしない」
 *
 * このモジュールの外で number をポイントとして扱わないよう、branded type で区別する。
 * 除算が必要な計算（期待値・還元率など）は ratio() を使い、分子分母を整数のまま保持する。
 */

declare const pointsBrand: unique symbol
declare const yenBrand: unique symbol

/** ポイント（整数・0 以上の値も負の値も取りうる。負値は台帳上の消費を表す） */
export type Points = number & { readonly [pointsBrand]: true }
/** 日本円（整数） */
export type Yen = number & { readonly [yenBrand]: true }

/** Int4 の範囲。DB 側も Int で持つため、ここで揃えて検査する。 */
export const INT_MIN = -2_147_483_648
export const INT_MAX = 2_147_483_647

export class AmountRangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmountRangeError'
  }
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new AmountRangeError(`${label} は整数である必要があります: ${value}`)
  }
  if (value < INT_MIN || value > INT_MAX) {
    throw new AmountRangeError(`${label} が扱える範囲を超えています: ${value}`)
  }
}

/** 検証つきで Points へ変換する。外部入力は必ずこれを通す。 */
export function points(value: number): Points {
  assertSafeInteger(value, 'ポイント')
  return value as Points
}

/** 検証つきで Yen へ変換する。 */
export function yen(value: number): Yen {
  assertSafeInteger(value, '金額')
  return value as Yen
}

/** 0 以上であることも保証する（残高・価格など負値が意味を持たない箇所で使う） */
export function nonNegativePoints(value: number): Points {
  const p = points(value)
  if (p < 0) {
    throw new AmountRangeError(`ポイントは 0 以上である必要があります: ${value}`)
  }
  return p
}

export function addPoints(a: Points, b: Points): Points {
  return points(a + b)
}

export function subPoints(a: Points, b: Points): Points {
  return points(a - b)
}

/** ポイント × 個数。10 連の合計計算などに使う（結果が Int 範囲を超えたら例外） */
export function multiplyPoints(amount: Points, count: number): Points {
  assertSafeInteger(count, '個数')
  return points(amount * count)
}

export function sumPoints(values: readonly Points[]): Points {
  return values.reduce<Points>((acc, v) => addPoints(acc, v), 0 as Points)
}

/**
 * 1 円 = 1 ポイントの換算。
 * 将来レートを変える場合もここだけを直せば済むようにする。
 * レートが 1:1 でなくなっても整数のままにするため、必ず分子分母の整数比で表現すること。
 */
export const YEN_TO_POINTS_NUMERATOR = 1
export const YEN_TO_POINTS_DENOMINATOR = 1

export function yenToPoints(amount: Yen): Points {
  const raw = (amount * YEN_TO_POINTS_NUMERATOR) / YEN_TO_POINTS_DENOMINATOR
  if (!Number.isInteger(raw)) {
    throw new AmountRangeError(
      `換算結果が整数になりません（${amount} 円）。換算レートは整数比で定義してください。`,
    )
  }
  return points(raw)
}

/**
 * 整数比。割り算の結果を number にせず、分子・分母のまま保持する。
 * 表示直前にのみ formatPercent などで文字列化する。
 */
export interface Ratio {
  readonly numerator: number
  readonly denominator: number
}

export function ratio(numerator: number, denominator: number): Ratio {
  assertSafeInteger(numerator, '分子')
  assertSafeInteger(denominator, '分母')
  if (denominator === 0) {
    throw new AmountRangeError('分母を 0 にはできません')
  }
  return { numerator, denominator }
}

/**
 * 確率・割合を「x.xxx%」形式へ整形する。
 * 内部では整数演算で桁を作ってから最後に文字列化するため、丸め誤差が蓄積しない。
 */
export function formatPercent(value: Ratio, fractionDigits = 3): string {
  const scale = 10 ** fractionDigits
  // 四捨五入を整数演算で行う
  const scaled = Math.round((value.numerator * 100 * scale) / value.denominator)
  const integerPart = Math.trunc(scaled / scale)
  const fractionPart = Math.abs(scaled % scale)
  if (fractionDigits === 0) {
    return `${integerPart}%`
  }
  return `${integerPart}.${String(fractionPart).padStart(fractionDigits, '0')}%`
}

/** 1/n 形式（「1/5000」のような当選確率表示）で整形する */
export function formatOdds(value: Ratio): string {
  if (value.numerator === 0) {
    return '0'
  }
  const denominator = Math.round(value.denominator / value.numerator)
  return `1/${denominator.toLocaleString('ja-JP')}`
}

/** 表示用フォーマット（日本語ロケール、3 桁区切り） */
export function formatPoints(value: Points | number): string {
  return `${value.toLocaleString('ja-JP')} P`
}

export function formatYen(value: Yen | number): string {
  return `${value.toLocaleString('ja-JP')} 円`
}
