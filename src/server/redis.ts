import Redis from 'ioredis'

import { serverEnv } from '@/lib/config/env.ts'
import { logger } from '@/lib/observability/index.ts'

/**
 * Redis 接続。
 *
 * 【重要】Redis は正式なデータソースではない。
 *  - 使ってよい用途: レート制限カウンタ、一覧・集計のキャッシュ、短命なロック
 *  - 使ってはいけない用途: ポイント残高、抽選結果、スロットの在庫状態
 *
 * 正式なデータソースは PostgreSQL のみ。Redis が落ちてもサービスの整合性は壊れず、
 * レート制限が無効化されるだけで済むよう、接続失敗時は null を返す設計にしている。
 */

const globalForRedis = globalThis as unknown as { redis?: Redis | null }

function createRedisClient(): Redis | null {
  const url = serverEnv().REDIS_URL
  if (!url) {
    logger.warn('REDIS_URL が未設定のため Redis を使用しません（レート制限は無効化されます）')
    return null
  }

  const client = new Redis(url, {
    // 起動時に Redis が居なくてもアプリを落とさない
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy(times) {
      if (times > 5) return null
      return Math.min(times * 200, 2_000)
    },
  })

  client.on('error', (error: Error) => {
    logger.warn('Redis への接続でエラーが発生しました', { error: error.message })
  })

  return client
}

export function getRedis(): Redis | null {
  if (globalForRedis.redis === undefined) {
    globalForRedis.redis = createRedisClient()
  }
  return globalForRedis.redis
}
