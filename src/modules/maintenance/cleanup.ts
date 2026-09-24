import type { PrismaClient } from '@/generated/prisma/client.ts'
import { now } from '@/lib/datetime/index.ts'
import { logger } from '@/lib/observability/index.ts'

/**
 * 期限切れレコードの掃除。
 *
 * ■ 何を消し、何を消さないか
 *   消すのは「期限が来たら意味を失う作業用のデータ」だけ。
 *   セッションと冪等性キーが対象で、台帳・抽選・監査ログには触れない。
 *   それらは追記専用で、DB トリガが DELETE を拒否する。
 *
 * ■ 消さなくても壊れない
 *   期限切れセッションは毎リクエストの有効性確認で弾かれ、
 *   期限切れ冪等性キーは expires_at で絞って再利用できないようにしている。
 *   このバッチは行数を抑えるためのもので、整合性の担保ではない。
 *   だから遅れても止まっても、利用者から見た挙動は変わらない。
 *
 * ■ まとめて消さない
 *   1 回の DELETE で何十万行も消すと、そのあいだロックが残り、
 *   ログイン処理が待たされる。少しずつ削り、上限で打ち切る。
 *   残った分は次回に回す（毎日動かす前提）。
 */

/** 1 回の DELETE で消す行数。ロックの保持時間を短く保つ。 */
const BATCH_SIZE = 1_000

/** 1 実行で消す上限。ここに達したら打ち切って次回へ回す。 */
const MAX_PER_RUN = 100_000

/**
 * 冪等性キーを消すまでの猶予。
 *
 * 期限切れの直後に消すと、遅れて届いた再送が「キーが無い＝初回」と見なされ、
 * 同じ操作がもう一度実行されうる。expires_at から十分に離してから消す。
 */
export const IDEMPOTENCY_GRACE_DAYS = 7

export interface CleanupResult {
  expiredSessions: number
  expiredIdempotencyKeys: number
  /** 上限に達して打ち切ったか。true なら次回も残りを消す。 */
  truncated: boolean
}

export interface CleanupOptions {
  /** 数えるだけで削除しない */
  dryRun?: boolean
}

export async function cleanupExpiredRecords(
  prisma: PrismaClient,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const at = now()
  const idempotencyCutoff = new Date(
    at.getTime() - IDEMPOTENCY_GRACE_DAYS * 24 * 60 * 60 * 1000,
  )

  if (options.dryRun) {
    const [expiredSessions, expiredIdempotencyKeys] = await Promise.all([
      prisma.userSession.count({ where: { expiresAt: { lt: at } } }),
      prisma.idempotencyKey.count({ where: { expiresAt: { lt: idempotencyCutoff } } }),
    ])
    return { expiredSessions, expiredIdempotencyKeys, truncated: false }
  }

  const sessions = await deleteInBatches(
    (take) =>
      prisma.userSession
        .findMany({ where: { expiresAt: { lt: at } }, select: { id: true }, take })
        .then((rows) => rows.map((row) => row.id)),
    (ids) => prisma.userSession.deleteMany({ where: { id: { in: ids } } }),
  )

  const keys = await deleteInBatches(
    (take) =>
      prisma.idempotencyKey
        .findMany({
          where: { expiresAt: { lt: idempotencyCutoff } },
          select: { id: true },
          take,
        })
        .then((rows) => rows.map((row) => row.id)),
    (ids) => prisma.idempotencyKey.deleteMany({ where: { id: { in: ids } } }),
  )

  const result: CleanupResult = {
    expiredSessions: sessions.deleted,
    expiredIdempotencyKeys: keys.deleted,
    truncated: sessions.truncated || keys.truncated,
  }

  logger.info('期限切れレコードを掃除しました', { ...result })
  return result
}

/**
 * 少しずつ消す。
 *
 * `deleteMany` は LIMIT を取れないので、対象の ID を先に取ってから消す。
 * 1 往復増えるが、1 回のロック範囲を BATCH_SIZE 行に抑えられる。
 */
async function deleteInBatches(
  fetchIds: (take: number) => Promise<string[]>,
  remove: (ids: string[]) => Promise<{ count: number }>,
): Promise<{ deleted: number; truncated: boolean }> {
  let deleted = 0

  while (deleted < MAX_PER_RUN) {
    const ids = await fetchIds(Math.min(BATCH_SIZE, MAX_PER_RUN - deleted))
    if (ids.length === 0) {
      return { deleted, truncated: false }
    }

    const removed = await remove(ids)
    deleted += removed.count

    // 取得はできたが 1 件も消せなかった場合（他の処理が先に消した等）、
    // 同じ行を延々と取り続けないように抜ける。
    if (removed.count === 0) {
      return { deleted, truncated: false }
    }
  }

  return { deleted, truncated: true }
}
