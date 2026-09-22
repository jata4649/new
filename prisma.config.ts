import path from 'node:path'

import { defineConfig, env } from 'prisma/config'

import { loadDotEnvFiles } from './src/lib/config/dotenv.ts'

/**
 * Prisma 7 から接続 URL は schema.prisma ではなくこのファイルで指定する。
 * Prisma CLI は .env を自動読み込みしないため、明示的に読み込む。
 */
loadDotEnvFiles()

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed/index.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
})
