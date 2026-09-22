import { serverEnv } from '@/lib/config/env.ts'

/**
 * ログ・エラー収集の抽象化レイヤ。
 *
 * 要件: 「Sentry を後から接続できるエラー処理構造」
 *
 * アプリ側は captureException / logger だけを使い、Sentry SDK に直接依存しない。
 * Phase 8 で setErrorReporter() に Sentry 実装を差し込めば全体が切り替わる。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

/** ログに出してはいけないキー。部分一致で伏せ字にする。 */
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwordhash',
  'secret',
  'token',
  'authorization',
  'cookie',
  'creditcard',
  'cardnumber',
  'cvv',
  'seed',
]

const REDACTED = '[REDACTED]'

/**
 * ログ・監査ログ・Sentry へ送る前に、機微情報を伏せ字にする。
 * 監査ログの before/after にも必ず通すこと（要件: パスワードハッシュ等を残さない）。
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]'
  if (value === null || value === undefined) return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replaceAll('_', '')
      result[key] = SENSITIVE_KEY_PATTERNS.some((p) => normalized.includes(p))
        ? REDACTED
        : redact(val, depth + 1)
    }
    return result
  }

  return value
}

export interface ErrorContext {
  requestId?: string
  userId?: string
  route?: string
  [key: string]: unknown
}

export interface ErrorReporter {
  captureException(error: unknown, context?: ErrorContext): void
  captureMessage(message: string, level: LogLevel, context?: ErrorContext): void
}

/** 既定の実装。標準出力に構造化ログを出すだけ。 */
const consoleReporter: ErrorReporter = {
  captureException(error, context) {
    const payload = {
      level: 'error' as const,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: redact(context ?? {}),
      timestamp: new Date().toISOString(),
    }
    console.error(JSON.stringify(payload))
  },
  captureMessage(message, level, context) {
    const payload = {
      level,
      message,
      context: redact(context ?? {}),
      timestamp: new Date().toISOString(),
    }
    // eslint-disable-next-line no-console -- ロガーの実装本体
    console.log(JSON.stringify(payload))
  },
}

let reporter: ErrorReporter = consoleReporter

/**
 * Sentry などの実装を差し込む。
 * Phase 8 で instrumentation.ts から呼び出す想定。
 */
export function setErrorReporter(next: ErrorReporter): void {
  reporter = next
}

export function resetErrorReporter(): void {
  reporter = consoleReporter
}

function currentLevel(): LogLevel {
  try {
    return serverEnv().LOG_LEVEL
  } catch {
    // 環境変数の検証前でもログは出せるようにする
    return 'info'
  }
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel()]
}

export const logger = {
  debug(message: string, context?: ErrorContext): void {
    if (shouldLog('debug')) reporter.captureMessage(message, 'debug', context)
  },
  info(message: string, context?: ErrorContext): void {
    if (shouldLog('info')) reporter.captureMessage(message, 'info', context)
  },
  warn(message: string, context?: ErrorContext): void {
    if (shouldLog('warn')) reporter.captureMessage(message, 'warn', context)
  },
  error(message: string, context?: ErrorContext): void {
    if (shouldLog('error')) reporter.captureMessage(message, 'error', context)
  },
}

export function captureException(error: unknown, context?: ErrorContext): void {
  reporter.captureException(error, context)
}
