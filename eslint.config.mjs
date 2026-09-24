import eslintConfigPrettier from 'eslint-config-prettier'
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import tseslint from 'typescript-eslint'

/**
 * レイヤ境界と危険な API の使用を「機械的に」禁止する。
 *
 * 人のレビューに頼ると必ず漏れるため、設計上の約束を Lint ルールへ落とし込む。
 *   - app/** から prisma を直接触らせない（必ず withApi → modules を経由させる）
 *   - modules/** から Next.js に依存させない（ドメインロジックを HTTP から独立させる）
 *   - points モジュールから Redis を触らせない（残高の真実は PostgreSQL のみ）
 *   - 抽選まわりで Math.random() を使わせない（CSPRNG 必須）
 */

const RESTRICT_PRISMA_IN_APP = {
  patterns: [
    {
      group: ['@/server/db', '@/server/db.ts', '**/server/db.ts'],
      message:
        'app/** から Prisma を直接使わないでください。withApi 経由で modules/** のサービスを呼び出してください。',
    },
    {
      group: ['@/generated/prisma/client', '@/generated/prisma/client.ts'],
      message:
        'app/** から PrismaClient を直接 import しないでください。型が必要な場合は modules/**/types.ts を経由してください。',
    },
  ],
}

const RESTRICT_NEXT_IN_MODULES = {
  patterns: [
    {
      group: ['next', 'next/*', 'next/**'],
      message:
        'modules/** は HTTP 層から独立させてください。Request / Response の処理は app/** と lib/api で行います。',
    },
  ],
}

const RESTRICT_REDIS_IN_POINTS = {
  patterns: [
    {
      group: ['@/server/redis', '@/server/redis.ts', 'ioredis'],
      message:
        'ポイント・抽選の正式なデータソースは PostgreSQL のみです。Redis を残高や抽選結果に使わないでください。',
    },
  ],
}

/**
 * クライアントコンポーネントが node 専用モジュールを引き込むのを防ぐ。
 *
 * 制限値だけが欲しくて `lib/uploads/images.ts` を import すると、
 * そこが使う `node:crypto` までブラウザのバンドルへ入ってしまう。
 * 画面から読みたい値は `lib/uploads/limits.ts` に置いてある。
 */
const RESTRICT_SERVER_ONLY_IN_COMPONENTS = {
  patterns: [
    {
      group: ['@/lib/uploads/images', '@/lib/uploads/images.ts', '@/server/*', '@/server/**'],
      message:
        'クライアントコンポーネントからサーバー専用モジュールを import しないでください（node 専用の依存がブラウザへ入ります）。制限値は @/lib/uploads/limits.ts にあります。',
    },
  ],
}

const NO_MATH_RANDOM = [
  {
    object: 'Math',
    property: 'random',
    message:
      '抽選・トークン生成には Math.random() を使えません。@/lib/crypto/random.ts の CSPRNG を使用してください。',
  },
]

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'src/generated/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'storage/**',
      'next-env.d.ts',
    ],
  },

  ...nextCoreWebVitals,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // 金額計算で暗黙の型変換が起きないようにする
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-properties': ['error', ...NO_MATH_RANDOM],
      'prefer-const': 'error',
    },
  },

  // --- レイヤ境界 ---
  {
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', RESTRICT_PRISMA_IN_APP],
    },
  },
  {
    files: ['src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', RESTRICT_NEXT_IN_MODULES],
    },
  },
  {
    files: ['src/modules/points/**/*.ts', 'src/modules/draws/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', RESTRICT_REDIS_IN_POINTS],
    },
  },
  {
    files: ['src/components/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', RESTRICT_SERVER_ONLY_IN_COMPONENTS],
    },
  },

  // --- 例外 ---
  {
    // ヘルスチェックは DB 到達性そのものを確認するため Prisma への直接アクセスを許可する
    files: ['src/app/api/health/route.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // 乱数ユーティリティ本体・スクリプト・テストは制約の対象外
    files: [
      'src/lib/crypto/random.ts',
      'scripts/**/*.ts',
      'prisma/**/*.ts',
      'src/tests/**/*.ts',
      '**/*.test.ts',
    ],
    rules: {
      'no-console': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-imports': 'off',
    },
  },

  eslintConfigPrettier,
)
