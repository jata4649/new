/**
 * 日時の扱い。
 *
 * 要件:
 *  - DB は UTC、表示は Asia/Tokyo
 *  - 日時判定はすべてサーバー時刻を基準にする（クライアント時刻を信用しない）
 *
 * PostgreSQL の timestamp(3) には UTC の Date がそのまま入る。
 * 表示層でのみ Intl.DateTimeFormat を使って Asia/Tokyo へ変換する。
 */

export const DISPLAY_TIME_ZONE = 'Asia/Tokyo'
export const DISPLAY_LOCALE = 'ja-JP'

/**
 * サーバー時刻を取得する唯一の入口。
 * テストでは setNowProvider() で固定時刻へ差し替えられる。
 */
let nowProvider: () => Date = () => new Date()

export function now(): Date {
  return nowProvider()
}

/** テスト専用。本番コードから呼ばないこと。 */
export function setNowProvider(provider: () => Date): void {
  nowProvider = provider
}

export function resetNowProvider(): void {
  nowProvider = () => new Date()
}

export function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
}

export function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60 * 1000)
}

export function isBefore(a: Date, b: Date): boolean {
  return a.getTime() < b.getTime()
}

export function isAfter(a: Date, b: Date): boolean {
  return a.getTime() > b.getTime()
}

/** 販売期間中かどうか。境界は [start, end) として扱う。 */
export function isWithinPeriod(target: Date, start: Date, end: Date): boolean {
  const t = target.getTime()
  return t >= start.getTime() && t < end.getTime()
}

const dateTimeFormatter = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

const dateFormatter = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** 「2026/09/22 14:30」形式（Asia/Tokyo） */
export function formatDateTimeJst(value: Date): string {
  return dateTimeFormatter.format(value)
}

/** 「2026/09/22」形式（Asia/Tokyo） */
export function formatDateJst(value: Date): string {
  return dateFormatter.format(value)
}

/**
 * HTML の <time datetime=""> 属性に入れる ISO 文字列（UTC）。
 * 表示テキストは JST、機械可読値は UTC という使い分けにする。
 */
export function toIsoUtc(value: Date): string {
  return value.toISOString()
}

/** JST における「その日」の開始時刻（UTC の Date として返す）。日次集計で使う。 */
export function startOfDayJst(value: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value)
  // en-CA は YYYY-MM-DD 形式。JST は UTC+9 固定（サマータイム無し）なので +09:00 を明示できる。
  return new Date(`${parts}T00:00:00+09:00`)
}
