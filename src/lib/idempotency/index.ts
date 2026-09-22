import { Prisma } from '@/generated/prisma/client.ts'
import { IdempotencyState } from '@/generated/prisma/enums.ts'
import { errors } from '@/lib/api/errors.ts'
import { sha256Hex } from '@/lib/crypto/random.ts'
import { addMinutes, now } from '@/lib/datetime/index.ts'
import { prisma, TRANSACTION_OPTIONS, type PrismaTransactionClient } from '@/server/db.ts'

/**
 * 冪等性（同じリクエストを何度送っても副作用は 1 回きり）。
 *
 * 要件: 「すべての購入、抽選、交換 API に冪等性を持たせる」
 *
 * ■ 仕組み
 *   冪等性キーの INSERT を「業務処理と同じトランザクションの最初」に置く。
 *
 *   1. 先行リクエスト: INSERT 成功 → 業務処理 → レスポンスを記録 → COMMIT
 *   2. 並行する重複リクエスト: 同じキーの INSERT がユニークインデックス上で
 *      **ブロックされる**（先行の COMMIT / ROLLBACK 待ち）
 *        - 先行が COMMIT → unique violation が発生し、自分のトランザクションは
 *          まるごとロールバックされる（＝副作用ゼロ）。その後、記録済みの
 *          レスポンスを読み直して返す（リプレイ）。
 *        - 先行が ROLLBACK → 行が消えるので INSERT が成功し、自分が処理を行う。
 *
 * ■ なぜ「別トランザクションで先にキーを INSERT」しないのか
 *   キーの登録と業務処理が別トランザクションだと、業務処理だけが成功して
 *   キーの更新に失敗した場合に「実行済みなのに未記録」の状態が生まれ、
 *   再送で二重実行されうる。同一トランザクションに入れればその隙間が消える。
 *
 * ■ IdempotencyState.FAILED について
 *   業務処理が失敗した場合はトランザクションごとロールバックされ、キーの行自体が
 *   消えるため、通常 FAILED は記録されない（再送すれば再実行される＝正しい）。
 *   外部プロバイダ都合の失敗を意図的に記録したい場合のために状態だけ用意している。
 */

/** 冪等性キーの保持期間 */
export const IDEMPOTENCY_TTL_MINUTES = 24 * 60

export interface IdempotencyContext {
  userId: string
  scope: string
  key: string
  /** リクエスト本文のハッシュ。同じキーで違う内容が来たら弾くために使う。 */
  requestHash: string
}

/**
 * リクエスト本文からハッシュを作る。
 * キーの順序に依存しないよう、オブジェクトのキーをソートしてから直列化する。
 */
export function buildRequestHash(body: unknown): string {
  return sha256Hex(stableStringify(body))
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

/** Prisma のユニーク制約違反（P2002）かどうか */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export interface IdempotentResult<T> {
  data: T
  /** true = 過去のレスポンスをそのまま返した（業務処理は実行していない） */
  replayed: boolean
}

/**
 * 冪等性つきでトランザクションを実行する。
 *
 * work にはトランザクションクライアントと、登録済み冪等性キーの ID が渡される。
 * 抽選・決済・発送申請など、キーを他テーブル（drawTransaction.idempotencyKeyId 等）へ
 * 紐付けたい処理のために ID を公開している。
 */
export async function runIdempotent<T>(
  context: IdempotencyContext,
  work: (tx: PrismaTransactionClient, idempotencyKeyId: string) => Promise<T>,
): Promise<IdempotentResult<T>> {
  try {
    const data = await prisma.$transaction(async (tx) => {
      const record = await tx.idempotencyKey.create({
        data: {
          userId: context.userId,
          scope: context.scope,
          key: context.key,
          requestHash: context.requestHash,
          state: IdempotencyState.IN_PROGRESS,
          expiresAt: addMinutes(now(), IDEMPOTENCY_TTL_MINUTES),
        },
        select: { id: true },
      })

      const result = await work(tx, record.id)

      await tx.idempotencyKey.update({
        where: { id: record.id },
        data: {
          state: IdempotencyState.SUCCEEDED,
          responseCode: 200,
          responseBody: result as Prisma.InputJsonValue,
        },
      })

      return result
    }, TRANSACTION_OPTIONS)

    return { data, replayed: false }
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error
    }
    // ここに来た時点で、先行リクエストは COMMIT 済み。記録されたレスポンスを返す。
    return { data: await replayStoredResponse<T>(context), replayed: true }
  }
}

async function replayStoredResponse<T>(context: IdempotencyContext): Promise<T> {
  const existing = await prisma.idempotencyKey.findUnique({
    where: {
      userId_scope_key: {
        userId: context.userId,
        scope: context.scope,
        key: context.key,
      },
    },
    select: { requestHash: true, state: true, responseBody: true },
  })

  if (!existing) {
    // 先行がロールバックした直後など、ごく稀に起こりうる。再送を促す。
    throw errors.requestInProgress()
  }

  if (existing.requestHash !== context.requestHash) {
    throw errors.idempotencyKeyConflict()
  }

  if (existing.state !== IdempotencyState.SUCCEEDED || existing.responseBody === null) {
    throw errors.requestInProgress()
  }

  return existing.responseBody as T
}

/** 期限切れの冪等性キーを削除する（日次バッチ用） */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: now() } },
  })
  return result.count
}
