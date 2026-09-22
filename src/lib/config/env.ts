import { z } from 'zod'

/**
 * 環境変数のスキーマ。
 *
 * 方針:
 *  - 起動時に一度だけ検証し、欠落・不正があれば **即座に落とす**。
 *    「本番で NEXTAUTH_SECRET が未設定のまま動いてしまった」を構造的に防ぐ。
 *  - 秘密情報はコードに直接書かない。既定値を持つのは非機密の設定だけ。
 *  - クライアントへ渡してよい値は NEXT_PUBLIC_ 接頭辞のものだけ（publicEnv に隔離）。
 */

/** 有償ポイントの有効期限の上限（日）。資金決済法の前払式支払手段に該当させないため 6 か月未満に固定する。 */
export const PAID_POINT_MAX_EXPIRY_DAYS = 180

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1')

const positiveInt = z.coerce.number().int().positive()

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // --- データベース / キャッシュ ---
  DATABASE_URL: z.string().min(1, 'DATABASE_URL は必須です'),
  SHADOW_DATABASE_URL: z.string().optional(),
  /** Redis はレート制限・一覧キャッシュ専用。残高や抽選結果の保存には使わない。 */
  REDIS_URL: z.string().optional(),

  // --- 認証 ---
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET は 32 文字以上のランダム文字列にしてください'),
  AUTH_URL: z.url().optional(),
  AUTH_SESSION_MAX_AGE_DAYS: positiveInt.default(30),

  // --- サイト公開モード（クローズドテスト運用） ---
  SITE_ACCESS_MODE: z.enum(['closed', 'public']).default('closed'),
  /** closed のとき全ページに要求する Basic 認証。closed なら必須。 */
  SITE_BASIC_AUTH_USER: z.string().optional(),
  SITE_BASIC_AUTH_PASSWORD: z.string().optional(),
  /** 管理画面を特定 IP に限定する場合にカンマ区切りで指定する。 */
  ADMIN_IP_ALLOWLIST: z.string().optional(),

  // --- ポイント ---
  /** 有償ポイントの有効期限（日）。PAID_POINT_MAX_EXPIRY_DAYS を超える値は拒否する。 */
  POINT_EXPIRY_DAYS_PAID: positiveInt.default(PAID_POINT_MAX_EXPIRY_DAYS),
  POINT_EXPIRY_DAYS_FREE: positiveInt.default(180),
  /**
   * 開発・テスト専用の有効期限短縮（分単位）。
   * production では無視される（本番で誤ってポイントを失効させないため）。
   */
  POINT_EXPIRY_MINUTES_OVERRIDE: z.coerce.number().int().positive().optional(),
  POINT_CONSUMPTION_STRATEGY: z
    .enum(['free_first', 'paid_first', 'expiry_only'])
    .default('free_first'),

  // --- 決済（MVP は mock のみ） ---
  PAYMENT_PROVIDER: z.literal('mock').default('mock'),
  MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(16).default('mock_webhook_secret_dev_only'),

  // --- アップロード ---
  UPLOAD_MAX_BYTES: positiveInt.default(5 * 1024 * 1024),
  UPLOAD_DIR: z.string().default('./storage/uploads'),

  // --- レート制限 ---
  RATE_LIMIT_ENABLED: booleanish.default(true),

  // --- 可観測性（Phase 8 で Sentry を接続する） ---
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

const publicSchema = z.object({
  NEXT_PUBLIC_SITE_NAME: z.string().default('オリパ（開発用テスト環境）'),
  /** UI に「テスト環境・現金決済なし」のバナーを出すか */
  NEXT_PUBLIC_TEST_MODE_BANNER: booleanish.default(true),
})

export type ServerEnv = z.infer<typeof serverSchema>
export type PublicEnv = z.infer<typeof publicSchema>

class EnvValidationError extends Error {
  constructor(issues: string[]) {
    super(`環境変数の検証に失敗しました:\n${issues.map((i) => `  - ${i}`).join('\n')}`)
    this.name = 'EnvValidationError'
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
}

/**
 * ビルド中かどうか。
 *
 * `next build` は NODE_ENV=production で実行されるため、そのままだと
 * 「本番用のシークレットを用意しないとビルドすらできない」状態になってしまう。
 * ビルド時はページ構成の収集のために環境変数を読むだけで、実際にリクエストは
 * 処理しないので、本番専用のルールはビルド時には適用しない。
 *
 * 実行時（next start / dev server）には通常どおり適用されるため、
 * 「本番なのに既定のシークレットのまま起動する」事故は引き続き防げる。
 */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build'
}

/**
 * 相互依存する制約の検証。単一フィールドの Zod ルールでは表現できないものをここに集約する。
 */
function validateCrossFieldRules(env: ServerEnv): string[] {
  // ビルド時は相互依存ルールを適用しない（上の isBuildPhase のコメントを参照）。
  // 実行時には必ず適用されるため、設定漏れのまま起動することはない。
  if (isBuildPhase()) {
    return []
  }

  const issues: string[] = []

  if (env.POINT_EXPIRY_DAYS_PAID > PAID_POINT_MAX_EXPIRY_DAYS) {
    issues.push(
      `POINT_EXPIRY_DAYS_PAID: 有償ポイントの有効期限は ${PAID_POINT_MAX_EXPIRY_DAYS} 日以下にしてください` +
        '（6 か月を超えると資金決済法上の前払式支払手段に該当しうるため）',
    )
  }

  if (env.SITE_ACCESS_MODE === 'closed') {
    if (!env.SITE_BASIC_AUTH_USER || !env.SITE_BASIC_AUTH_PASSWORD) {
      issues.push(
        'SITE_BASIC_AUTH_USER / SITE_BASIC_AUTH_PASSWORD: ' +
          'SITE_ACCESS_MODE=closed では Basic 認証の資格情報が必須です',
      )
    }
  }

  if (env.NODE_ENV === 'production') {
    if (env.MOCK_PAYMENT_WEBHOOK_SECRET === 'mock_webhook_secret_dev_only') {
      issues.push('MOCK_PAYMENT_WEBHOOK_SECRET: 本番既定値のままにはできません')
    }
    if (!env.REDIS_URL && env.RATE_LIMIT_ENABLED) {
      issues.push('REDIS_URL: レート制限を有効にする場合は Redis が必要です')
    }
    if (env.SITE_ACCESS_MODE === 'public') {
      issues.push(
        'SITE_ACCESS_MODE: 本 MVP は現金決済・法務確認が未完了のため public にできません',
      )
    }
  }

  return issues
}

function loadServerEnv(): ServerEnv {
  const parsed = serverSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new EnvValidationError(formatIssues(parsed.error))
  }

  const crossFieldIssues = validateCrossFieldRules(parsed.data)
  if (crossFieldIssues.length > 0) {
    throw new EnvValidationError(crossFieldIssues)
  }

  return parsed.data
}

function loadPublicEnv(): PublicEnv {
  // Next.js は NEXT_PUBLIC_* をビルド時にインライン展開するため、明示的に列挙する必要がある
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_SITE_NAME: process.env.NEXT_PUBLIC_SITE_NAME,
    NEXT_PUBLIC_TEST_MODE_BANNER: process.env.NEXT_PUBLIC_TEST_MODE_BANNER,
  })
  if (!parsed.success) {
    throw new EnvValidationError(formatIssues(parsed.error))
  }
  return parsed.data
}

let cachedServerEnv: ServerEnv | null = null

/**
 * サーバー専用の環境変数を取得する。
 * クライアントバンドルから呼ぶと DATABASE_URL 等が漏れるため、サーバーコードからのみ使うこと。
 * （src/lib/config/env.ts の import は ESLint の no-restricted-imports でクライアント境界を制限している）
 */
export function serverEnv(): ServerEnv {
  cachedServerEnv ??= loadServerEnv()
  return cachedServerEnv
}

/** テスト用: キャッシュを破棄して再読み込みさせる */
export function resetServerEnvCache(): void {
  cachedServerEnv = null
}

export const publicEnv: PublicEnv = loadPublicEnv()

/** テストから直接スキーマを検証したい場合に使う */
export const __internal = { serverSchema, validateCrossFieldRules }
