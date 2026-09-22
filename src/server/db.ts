import { PrismaPg } from '@prisma/adapter-pg'

import { type Prisma, PrismaClient } from '@/generated/prisma/client.ts'
import { serverEnv } from '@/lib/config/env.ts'

/**
 * PrismaClient のシングルトン。
 *
 * Prisma 7 はドライバアダプタ経由で接続する（Rust エンジンを同梱しない）。
 * 開発時の HMR で接続が増え続けないよう globalThis にキャッシュする。
 *
 * 【重要】トランザクションの扱い
 *  - 金銭・抽選に関わる処理は必ず $transaction（interactive transaction）で囲む。
 *  - トランザクション内では DB 操作だけを行う。
 *    外部 API 呼び出し・画像処理・メール送信を挟むと、コネクションを長時間占有して
 *    プール枯渇を招く（設計書 docs/01-architecture.md のリスク R2）。
 *  - 分離レベルは既定の ReadCommitted。行ロック（FOR UPDATE SKIP LOCKED）と
 *    条件付き UPDATE・一意制約で整合性を担保する方針のため、Serializable は使わない。
 */

const TRANSACTION_DEFAULTS = {
  /** トランザクション開始までの待機上限（ミリ秒） */
  maxWait: 5_000,
  /** トランザクション全体の実行上限（ミリ秒）。超えたらロールバックされる。 */
  timeout: 10_000,
} as const

export const TRANSACTION_OPTIONS = TRANSACTION_DEFAULTS

function createPrismaClient(): PrismaClient {
  const env = serverEnv()
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })

  return new PrismaClient({
    adapter,
    log:
      env.NODE_ENV === 'development'
        ? [
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ]
        : [{ emit: 'stdout', level: 'error' }],
  })
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

/**
 * トランザクション内で渡されるクライアント型。
 * サービス層は PrismaClient ではなくこの型を受け取り、
 * 「トランザクション外から呼ばれる」ことを型で防ぐ。
 */
export type PrismaTransactionClient = Prisma.TransactionClient
