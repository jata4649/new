import { defineConfig, devices } from '@playwright/test'

/**
 * E2E テスト設定。
 *
 * 要件 14 の E2E シナリオ（管理者ログイン → 在庫登録 → オリパ作成 → 公開 →
 * ユーザー登録 → テストポイント購入 → 抽選 → 演出 → 交換 → 発送申請 → 発送処理）
 * は Phase 2 以降で順次追加する。Phase 1 では基盤が起動することだけを確認する。
 *
 * スマートフォンファーストのため、既定のプロジェクトはモバイルビューポートにする。
 */

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000'

/**
 * CI コンテナなどで Chromium が別の場所に用意されている場合に備え、
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE で実行ファイルを差し替えられるようにする。
 * 未指定なら Playwright が管理するブラウザを使う。
 */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
const launchOptions = chromiumExecutable
  ? { launchOptions: { executablePath: chromiumExecutable } }
  : {}

export default defineConfig({
  testDir: './src/tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    // クローズドテスト中は全ページが Basic 認証で保護されている
    httpCredentials:
      process.env.SITE_ACCESS_MODE === 'public'
        ? undefined
        : {
            username: process.env.SITE_BASIC_AUTH_USER ?? 'tester',
            password: process.env.SITE_BASIC_AUTH_PASSWORD ?? 'closed_test_password',
          },
  },

  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], ...launchOptions } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...launchOptions } },
  ],

  // E2E_BASE_URL が指定されている場合は、すでに起動しているサーバーを使う。
  // 指定が無ければ Playwright がサーバーを起動する。
  // CI のようにビルド済みの環境では PLAYWRIGHT_WEB_SERVER_COMMAND='pnpm start' を
  // 指定して、ビルドの二重実行を避ける。
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: process.env.PLAYWRIGHT_WEB_SERVER_COMMAND ?? 'pnpm build && pnpm start',
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
})
