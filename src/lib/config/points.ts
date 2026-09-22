import { PointType } from '@/generated/prisma/enums.ts'
import { PAID_POINT_MAX_EXPIRY_DAYS, serverEnv } from '@/lib/config/env.ts'
import { addDays, addMinutes } from '@/lib/datetime/index.ts'

/**
 * ポイント運用の設定。
 *
 * 要件:
 *  - 消費順序は「有効期限が近い無償 → 有効期限が近い有償」だが、変更できる構造にする
 *  - 有効期限の初期値は 180 日。開発中はテスト用に短縮できるようにする
 */

export interface ConsumptionRule {
  /** null = 種別を問わない（expiry_only 戦略で使用） */
  pointType: PointType | null
  /** 同一グループ内の並び順。常に有効期限が近いものから消費する。 */
  order: 'expiresAtAsc'
}

export type ConsumptionStrategy = 'free_first' | 'paid_first' | 'expiry_only'

const STRATEGIES: Record<ConsumptionStrategy, readonly ConsumptionRule[]> = {
  /** 既定: 無償を先に使い切る（ユーザーにとって有利。有償ポイントが長く残る） */
  free_first: [
    { pointType: PointType.FREE, order: 'expiresAtAsc' },
    { pointType: PointType.PAID, order: 'expiresAtAsc' },
  ],
  paid_first: [
    { pointType: PointType.PAID, order: 'expiresAtAsc' },
    { pointType: PointType.FREE, order: 'expiresAtAsc' },
  ],
  /** 種別を問わず、単純に期限が近い順 */
  expiry_only: [{ pointType: null, order: 'expiresAtAsc' }],
}

export function consumptionRules(): readonly ConsumptionRule[] {
  return STRATEGIES[serverEnv().POINT_CONSUMPTION_STRATEGY]
}

/**
 * 発行するポイントの有効期限を計算する。
 *
 * - 有償ポイントは PAID_POINT_MAX_EXPIRY_DAYS（180 日 = 6 か月未満）を超えられない。
 *   6 か月を超えると資金決済法上の前払式支払手段に該当しうるため、
 *   設定値がそれを超えていた場合は上限で切り詰める（env.ts でも起動時に弾いている）。
 * - 開発・テスト環境に限り POINT_EXPIRY_MINUTES_OVERRIDE で分単位に短縮できる。
 *   本番では無視される。
 */
export function calculateExpiresAt(pointType: PointType, issuedAt: Date): Date {
  const env = serverEnv()

  if (env.NODE_ENV !== 'production' && env.POINT_EXPIRY_MINUTES_OVERRIDE !== undefined) {
    return addMinutes(issuedAt, env.POINT_EXPIRY_MINUTES_OVERRIDE)
  }

  if (pointType === PointType.PAID) {
    const days = Math.min(env.POINT_EXPIRY_DAYS_PAID, PAID_POINT_MAX_EXPIRY_DAYS)
    return addDays(issuedAt, days)
  }

  return addDays(issuedAt, env.POINT_EXPIRY_DAYS_FREE)
}

/** 1 回の抽選で指定できる口数 */
export const ALLOWED_DRAW_COUNTS: readonly number[] = [1, 10]

export function isAllowedDrawCount(count: number): boolean {
  return ALLOWED_DRAW_COUNTS.includes(count)
}
