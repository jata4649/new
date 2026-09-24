import path from 'node:path'

import { defineConfig } from 'vitest/config'

/**
 * テストは 3 つのプロジェクトに分ける。
 *
 *   unit        … DB 不要。純粋関数のみ。常に高速に回す。
 *   integration … DB が必要。サービス層をトランザクションごと検証する。
 *   concurrency … DB が必要。同時実行の競合を検証する。直列実行かつ長めのタイムアウト。
 *
 * 要件で求められている同時実行テスト（残り 1 口への同時抽選など）は
 * 並列実行されると互いに干渉するため、concurrency は必ず単一ワーカーで動かす。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    // 同時実行テスト（concurrency）は Phase 5 で追加するまでファイルが無い。
    // 0 件を失敗にすると CI が落ちるため、成功として扱う。
    // ルート設定にしか効かないオプションなのでここへ置いている。
    passWithNoTests: true,
    projects: [
      {
        resolve: {
          alias: { '@': path.resolve(import.meta.dirname, './src') },
        },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/tests/unit/**/*.test.ts'],
        },
      },
      {
        resolve: {
          alias: { '@': path.resolve(import.meta.dirname, './src') },
        },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/tests/integration/**/*.test.ts'],
          setupFiles: ['src/tests/helpers/setup-db.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // 同一 DB を共有するため直列実行する
          fileParallelism: false,
        },
      },
      {
        resolve: {
          alias: { '@': path.resolve(import.meta.dirname, './src') },
        },
        test: {
          name: 'concurrency',
          environment: 'node',
          include: ['src/tests/concurrency/**/*.test.ts'],
          setupFiles: ['src/tests/helpers/setup-db.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // 競合検証は単一ワーカー・直列で行う（テスト同士が干渉しないように）
          fileParallelism: false,
          pool: 'forks',
          maxWorkers: 1,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**', 'src/modules/**'],
      exclude: ['src/generated/**', '**/*.test.ts'],
    },
  },
})
