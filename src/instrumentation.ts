/**
 * Next.js の起動時フック。
 *
 * ここで行うこと:
 *  1. 環境変数の検証（不備があればこの時点で落とす）
 *  2. セッション解決の実装を登録する
 *  3. Phase 8 で Sentry を接続する
 *
 * Edge ランタイムでは Prisma も node:crypto も使えないため、
 * nodejs ランタイムのときだけ初期化する。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return
  }

  const { serverEnv } = await import('@/lib/config/env.ts')
  // 起動時に一度だけ検証する。設定漏れのまま稼働させない。
  serverEnv()

  const { registerSessionResolver } = await import('@/server/session-bootstrap.ts')
  registerSessionResolver()

  // Phase 8:
  //   const { setErrorReporter } = await import('@/lib/observability/index.ts')
  //   setErrorReporter(createSentryReporter(serverEnv().SENTRY_DSN))
}
