/**
 * 抽選の設定。
 *
 * 要件:「1 回抽選と 10 連抽選」。将来 5 連などを足せるよう、
 * 口数は定数配列で持ち、Zod とサービス層の両方がこれを唯一の根拠にする。
 *
 * 【重要】口数をユーザー入力から自由に受け取らない。
 *   任意の口数を許すと「残り口数ぴったりを一撃で買い占める」ような
 *   運用上望ましくない挙動や、10 連ボーナスの設計が破綻する。
 */

/** 指定できる抽選口数 */
export const ALLOWED_DRAW_COUNTS = [1, 10] as const

export type DrawCount = (typeof ALLOWED_DRAW_COUNTS)[number]

export function isAllowedDrawCount(value: number): value is DrawCount {
  return (ALLOWED_DRAW_COUNTS as readonly number[]).includes(value)
}

/**
 * 1 トランザクションで確保するスロット数の上限。
 *
 * ALLOWED_DRAW_COUNTS の最大値と一致させる。
 * サービス層はこの値を超える要求を受け付けない（ロック時間の上限を決めるため）。
 */
export const MAX_SLOTS_PER_DRAW = Math.max(...ALLOWED_DRAW_COUNTS)
