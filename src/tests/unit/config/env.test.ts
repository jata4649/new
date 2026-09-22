import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PAID_POINT_MAX_EXPIRY_DAYS, __internal } from '@/lib/config/env.ts'

/**
 * 環境変数の検証。
 *
 * 「本番で設定漏れのまま起動してしまった」を防ぐことが目的なので、
 * 落ちるべきケースで確実に落ちることを確認する。
 */

const { serverSchema, validateCrossFieldRules } = __internal

const VALID_BASE = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AUTH_SECRET: 'a'.repeat(32),
  SITE_ACCESS_MODE: 'closed',
  SITE_BASIC_AUTH_USER: 'tester',
  SITE_BASIC_AUTH_PASSWORD: 'password',
} as const

function parse(overrides: Record<string, unknown> = {}) {
  return serverSchema.safeParse({ ...VALID_BASE, ...overrides })
}

describe('serverSchema', () => {
  it('最小構成を受け入れ、既定値を埋める', () => {
    const result = parse()
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.POINT_EXPIRY_DAYS_PAID).toBe(PAID_POINT_MAX_EXPIRY_DAYS)
    expect(result.data.POINT_CONSUMPTION_STRATEGY).toBe('free_first')
    expect(result.data.RATE_LIMIT_ENABLED).toBe(true)
    expect(result.data.PAYMENT_PROVIDER).toBe('mock')
  })

  it('DATABASE_URL が無ければ失敗する', () => {
    const result = parse({ DATABASE_URL: undefined })
    expect(result.success).toBe(false)
  })

  it('AUTH_SECRET が短ければ失敗する', () => {
    const result = parse({ AUTH_SECRET: 'too-short' })
    expect(result.success).toBe(false)
  })

  it('真偽値を文字列でも受け取れる', () => {
    const result = parse({ RATE_LIMIT_ENABLED: 'false' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.RATE_LIMIT_ENABLED).toBe(false)
    }
  })
})

describe('validateCrossFieldRules', () => {
  function build(overrides: Record<string, unknown> = {}) {
    const result = parse(overrides)
    if (!result.success) {
      throw new Error(`テスト用の環境変数が不正です: ${result.error.message}`)
    }
    return result.data
  }

  it('妥当な設定では問題を返さない', () => {
    expect(validateCrossFieldRules(build())).toEqual([])
  })

  it('有償ポイントの有効期限が 180 日を超えたら拒否する（資金決済法リスク）', () => {
    const issues = validateCrossFieldRules(build({ POINT_EXPIRY_DAYS_PAID: 365 }))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('POINT_EXPIRY_DAYS_PAID')
  })

  it('180 日ちょうどは許可する', () => {
    expect(validateCrossFieldRules(build({ POINT_EXPIRY_DAYS_PAID: 180 }))).toEqual([])
  })

  it('無償ポイントには 180 日の上限を適用しない', () => {
    expect(validateCrossFieldRules(build({ POINT_EXPIRY_DAYS_FREE: 365 }))).toEqual([])
  })

  it('closed なのに Basic 認証の資格情報が無ければ拒否する', () => {
    const issues = validateCrossFieldRules(
      build({ SITE_BASIC_AUTH_USER: undefined, SITE_BASIC_AUTH_PASSWORD: undefined }),
    )
    expect(issues.some((i) => i.includes('SITE_BASIC_AUTH_USER'))).toBe(true)
  })

  it('production で Webhook シークレットが既定値なら拒否する', () => {
    const issues = validateCrossFieldRules(build({ NODE_ENV: 'production' }))
    expect(issues.some((i) => i.includes('MOCK_PAYMENT_WEBHOOK_SECRET'))).toBe(true)
  })

  it('production で public 公開を拒否する（MVP は非公開のテスト環境）', () => {
    const issues = validateCrossFieldRules(
      build({
        NODE_ENV: 'production',
        SITE_ACCESS_MODE: 'public',
        MOCK_PAYMENT_WEBHOOK_SECRET: 'a-sufficiently-long-secret',
        REDIS_URL: 'redis://localhost:6379',
      }),
    )
    expect(issues.some((i) => i.includes('SITE_ACCESS_MODE'))).toBe(true)
  })
})

describe('ポイント有効期限の計算', () => {
  // serverEnv() のキャッシュを汚さないよう、環境変数を直接操作して import し直す
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv, ...VALID_BASE } as NodeJS.ProcessEnv
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('有償ポイントは 180 日で失効する', async () => {
    const { resetServerEnvCache } = await import('@/lib/config/env.ts')
    const { calculateExpiresAt } = await import('@/lib/config/points.ts')
    const { PointType } = await import('@/generated/prisma/enums.ts')

    resetServerEnvCache()
    const issuedAt = new Date('2026-01-01T00:00:00Z')
    const expiresAt = calculateExpiresAt(PointType.PAID, issuedAt)

    const days = (expiresAt.getTime() - issuedAt.getTime()) / (24 * 60 * 60 * 1000)
    expect(days).toBe(180)
  })

  it('設定値が上限を超えていても 180 日で切り詰める', async () => {
    process.env['POINT_EXPIRY_DAYS_PAID'] = '9999'
    const { resetServerEnvCache } = await import('@/lib/config/env.ts')
    const { calculateExpiresAt } = await import('@/lib/config/points.ts')
    const { PointType } = await import('@/generated/prisma/enums.ts')

    resetServerEnvCache()
    // env.ts の起動時検証では例外になるが、calculateExpiresAt 側でも二重に守る
    let expiresAt: Date
    try {
      const issuedAt = new Date('2026-01-01T00:00:00Z')
      expiresAt = calculateExpiresAt(PointType.PAID, issuedAt)
      const days = (expiresAt.getTime() - issuedAt.getTime()) / (24 * 60 * 60 * 1000)
      expect(days).toBeLessThanOrEqual(PAID_POINT_MAX_EXPIRY_DAYS)
    } catch (error) {
      // 起動時検証で弾かれるのが本来の挙動
      expect((error as Error).message).toContain('POINT_EXPIRY_DAYS_PAID')
    }
  })
})
