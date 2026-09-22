import { serverEnv } from '@/lib/config/env.ts'
import { logger } from '@/lib/observability/index.ts'
import { getRedis } from '@/server/redis.ts'

/**
 * レート制限。
 *
 * 要件: 「API にレート制限を追加できる構造にする」
 *
 * 実装: Redis の固定ウィンドウカウンタ（INCR + EXPIRE）。
 *  - Redis が無い / 落ちている場合は「許可」にフォールバックする。
 *    レート制限は可用性のための仕組みであり、整合性の担保には使っていないため、
 *    落ちたときに全リクエストを拒否するよりサービス継続を優先する。
 *  - 整合性（二重抽選・二重付与の防止）は PostgreSQL 側の冪等性キーで守るため、
 *    Redis の欠損がデータ破壊につながることはない。
 */

export interface RateLimitRule {
  /** 制限の名前空間（'draw' / 'login' / 'admin' など） */
  name: string
  /** ウィンドウあたりの許可回数 */
  limit: number
  /** ウィンドウ長（秒） */
  windowSeconds: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

/** 代表的なルール。エンドポイントごとに withApi へ渡す。 */
export const RATE_LIMIT_RULES = {
  login: { name: 'login', limit: 5, windowSeconds: 15 * 60 },
  signup: { name: 'signup', limit: 3, windowSeconds: 60 * 60 },
  draw: { name: 'draw', limit: 60, windowSeconds: 60 },
  mutation: { name: 'mutation', limit: 30, windowSeconds: 60 },
  read: { name: 'read', limit: 120, windowSeconds: 60 },
  admin: { name: 'admin', limit: 60, windowSeconds: 60 },
  webhook: { name: 'webhook', limit: 300, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>

const ALLOWED_FALLBACK: RateLimitResult = {
  allowed: true,
  remaining: Number.MAX_SAFE_INTEGER,
  retryAfterSeconds: 0,
}

/**
 * 識別子ごとの試行回数を数える。
 * identifier にはユーザー ID（ログイン済み）または IP（未ログイン）を渡す。
 */
export async function checkRateLimit(
  rule: RateLimitRule,
  identifier: string,
): Promise<RateLimitResult> {
  if (!serverEnv().RATE_LIMIT_ENABLED) {
    return ALLOWED_FALLBACK
  }

  const redis = getRedis()
  if (!redis) {
    return ALLOWED_FALLBACK
  }

  // 固定ウィンドウ。ウィンドウ境界をキーに含めることで期限管理を単純化する。
  const windowIndex = Math.floor(Date.now() / 1000 / rule.windowSeconds)
  const key = `ratelimit:${rule.name}:${identifier}:${windowIndex}`

  try {
    const pipeline = redis.pipeline()
    pipeline.incr(key)
    pipeline.expire(key, rule.windowSeconds)
    const replies = await pipeline.exec()

    const rawCount = replies?.[0]?.[1]
    const count = typeof rawCount === 'number' ? rawCount : Number(rawCount ?? 0)

    if (count > rule.limit) {
      const windowEnd = (windowIndex + 1) * rule.windowSeconds
      const retryAfterSeconds = Math.max(1, windowEnd - Math.floor(Date.now() / 1000))
      return { allowed: false, remaining: 0, retryAfterSeconds }
    }

    return {
      allowed: true,
      remaining: Math.max(0, rule.limit - count),
      retryAfterSeconds: 0,
    }
  } catch (error) {
    // Redis 障害時はサービスを止めない
    logger.warn('レート制限の判定に失敗したため許可します', {
      rule: rule.name,
      error: error instanceof Error ? error.message : String(error),
    })
    return ALLOWED_FALLBACK
  }
}
