import { PointTxType, PointType } from '@/generated/prisma/enums.ts'
import { errors } from '@/lib/api/errors.ts'
import { serverEnv } from '@/lib/config/env.ts'
import { calculateExpiresAt } from '@/lib/config/points.ts'
import { now } from '@/lib/datetime/index.ts'
import { points, type Points } from '@/lib/money/points.ts'
import type { PrismaTransactionClient } from '@/server/db.ts'

import {
  applyBalanceDelta,
  decrementLot,
  getSpendableBalance,
  incrementLot,
  lockConsumableLots,
} from './repository.ts'

/**
 * ポイント台帳。
 *
 * ■ 唯一の書き込み経路
 *   ポイントの増減は必ずこのファイルの関数を通す。
 *   point_accounts を直接 UPDATE するコードは他に存在しない。
 *
 * ■ すべて呼び出し側のトランザクション内で動く
 *   引数で tx を受け取り、自分ではトランザクションを開かない。
 *   これにより「抽選とポイント消費」「決済とポイント付与」が
 *   確実に 1 つのトランザクションに収まる。
 *   ポイントだけ減って抽選されない状態は原理的に発生しない。
 *
 * ■ 記録の構造（docs/07-point-ledger.md）
 *   point_ledger_entries  … 真実（追記専用）
 *   point_lot_consumptions… どのロットから引いたかの明細
 *   point_lots            … 有効期限つき残高の実体
 *   point_accounts        … 高速参照用キャッシュ
 */

export interface LedgerContext {
  /** 管理者操作の場合の実行者 ID */
  actorId?: string | null
}

export interface GrantParams {
  userId: string
  amount: number
  pointType: PointType
  txType: PointTxType
  /** 'PAYMENT_TRANSACTION' | 'USER_PRIZE' | 'ADMIN' など */
  sourceType?: string | null
  sourceId?: string | null
  /** ADJUSTMENT / REVERSAL では必須（DB の CHECK 制約でも強制される） */
  reason?: string | null
  /** 明示したい場合のみ。既定は種別ごとの設定値から計算する。 */
  expiresAt?: Date
}

export interface GrantResult {
  ledgerEntryId: string
  lotId: string
  amount: Points
  expiresAt: Date
  balanceAfter: number
}

/**
 * ポイントを発行する。
 *
 * 新しいロットを 1 件作り、台帳へ記帳し、口座キャッシュを更新する。
 * 既存ロットへ加算することはしない（有効期限が混ざってしまうため）。
 */
export async function grantPoints(
  tx: PrismaTransactionClient,
  params: GrantParams,
  context: LedgerContext = {},
): Promise<GrantResult> {
  const amount = points(params.amount)
  if (amount <= 0) {
    throw errors.conflict('付与するポイントは 1 以上である必要があります', {
      amount: params.amount,
    })
  }

  requireReasonIfNeeded(params.txType, params.reason)

  const issuedAt = now()
  const expiresAt = params.expiresAt ?? calculateExpiresAt(params.pointType, issuedAt)

  const lot = await tx.pointLot.create({
    data: {
      userId: params.userId,
      pointType: params.pointType,
      amountIssued: amount,
      amountRemaining: amount,
      issuedAt,
      expiresAt,
      sourceType: params.txType,
      sourceId: params.sourceId ?? null,
    },
    select: { id: true },
  })

  const balance = await applyBalanceDelta(
    tx,
    params.userId,
    params.pointType === PointType.PAID ? amount : 0,
    params.pointType === PointType.FREE ? amount : 0,
  )

  if (!balance) {
    // 口座が存在しない場合のみ起こりうる（登録時に必ず作られる）
    throw errors.internal(new Error('ポイント口座が見つかりません'), {
      userId: params.userId,
    })
  }

  const balanceAfter = balance.paidBalance + balance.freeBalance

  const entry = await tx.pointLedgerEntry.create({
    data: {
      userId: params.userId,
      txType: params.txType,
      pointType: params.pointType,
      amount,
      balanceAfter,
      reason: params.reason ?? null,
      sourceType: params.sourceType ?? null,
      sourceId: params.sourceId ?? null,
      createdBy: context.actorId ?? null,
    },
    select: { id: true },
  })

  return {
    ledgerEntryId: entry.id,
    lotId: lot.id,
    amount,
    expiresAt,
    balanceAfter,
  }
}

export interface ConsumeParams {
  userId: string
  amount: number
  txType: PointTxType
  sourceType?: string | null
  sourceId?: string | null
  reason?: string | null
}

export interface ConsumeBreakdown {
  lotId: string
  amount: number
  pointType: PointType
}

export interface ConsumeResult {
  ledgerEntryId: string
  /** 消費した内訳。返金・取消しで元のロットへ戻すために使う。 */
  breakdown: ConsumeBreakdown[]
  paidConsumed: number
  freeConsumed: number
  balanceAfter: number
}

/**
 * ポイントを消費する。
 *
 * 設定された消費順序（既定: 無償 → 有償、各々期限が近い順）で
 * ロットをロックし、先頭から順に引いていく。
 *
 * 残高が足りなければ **何も変更せずに** INSUFFICIENT_POINTS を投げる。
 * 呼び出し側のトランザクションごとロールバックされるため、
 * 「ポイントだけ減る」ことは起こらない。
 */
export async function consumePoints(
  tx: PrismaTransactionClient,
  params: ConsumeParams,
  context: LedgerContext = {},
): Promise<ConsumeResult> {
  const amount = points(params.amount)
  if (amount <= 0) {
    throw errors.conflict('消費するポイントは 1 以上である必要があります', {
      amount: params.amount,
    })
  }

  requireReasonIfNeeded(params.txType, params.reason)

  const at = now()
  const strategy = serverEnv().POINT_CONSUMPTION_STRATEGY
  const lots = await lockConsumableLots(tx, params.userId, strategy, at)

  const available = lots.reduce((sum, lot) => sum + lot.amountRemaining, 0)
  if (available < amount) {
    throw errors.insufficientPoints({
      required: amount,
      available,
      userId: params.userId,
    })
  }

  // 先頭のロットから順に充当する
  const breakdown: ConsumeBreakdown[] = []
  let remaining: number = amount

  for (const lot of lots) {
    if (remaining === 0) break

    const take = Math.min(lot.amountRemaining, remaining)
    const applied = await decrementLot(tx, lot.id, take, at)
    if (!applied) {
      // ロック済みの行が動くことは無いはずなので、起きたら不整合
      throw errors.internal(new Error('ロットの更新に失敗しました'), {
        lotId: lot.id,
        take,
      })
    }

    breakdown.push({ lotId: lot.id, amount: take, pointType: lot.pointType })
    remaining -= take
  }

  if (remaining !== 0) {
    throw errors.internal(new Error('ポイントの充当が完了しませんでした'), {
      remaining,
      userId: params.userId,
    })
  }

  const paidConsumed = sumBy(breakdown, PointType.PAID)
  const freeConsumed = sumBy(breakdown, PointType.FREE)

  const balance = await applyBalanceDelta(tx, params.userId, -paidConsumed, -freeConsumed)
  if (!balance) {
    // 口座キャッシュとロットがずれている。ここで止めて調査させる。
    throw errors.insufficientPoints({
      reason: 'balance_cache_mismatch',
      userId: params.userId,
      paidConsumed,
      freeConsumed,
    })
  }

  const balanceAfter = balance.paidBalance + balance.freeBalance

  const entry = await tx.pointLedgerEntry.create({
    data: {
      userId: params.userId,
      txType: params.txType,
      // 複数種別にまたがる場合は null。内訳は consumptions を参照する。
      pointType: resolvePointType(paidConsumed, freeConsumed),
      amount: -amount,
      balanceAfter,
      reason: params.reason ?? null,
      sourceType: params.sourceType ?? null,
      sourceId: params.sourceId ?? null,
      createdBy: context.actorId ?? null,
      consumptions: {
        create: breakdown.map((item) => ({
          lotId: item.lotId,
          amount: item.amount,
        })),
      },
    },
    select: { id: true },
  })

  return {
    ledgerEntryId: entry.id,
    breakdown,
    paidConsumed,
    freeConsumed,
    balanceAfter,
  }
}

export interface ReverseParams {
  /** 取り消す対象の記帳 ID（消費のエントリ） */
  ledgerEntryId: string
  txType: PointTxType
  /** 理由は必須 */
  reason: string
  sourceType?: string | null
  sourceId?: string | null
}

/**
 * 消費を取り消し、**元のロットへ**戻す。
 *
 * 有効期限を元のまま保つために、消費明細（point_lot_consumptions）を辿る。
 * これが消費明細テーブルを持つ最大の理由。
 *
 * すでに失効したロットへは戻せない。その場合は残高を増やさず、
 * 呼び出し側へ戻せなかった額を返す（補填は管理者の判断に委ねる）。
 */
export async function reverseConsumption(
  tx: PrismaTransactionClient,
  params: ReverseParams,
  context: LedgerContext = {},
): Promise<{ ledgerEntryId: string; restored: number; unrestorable: number }> {
  const original = await tx.pointLedgerEntry.findUnique({
    where: { id: params.ledgerEntryId },
    select: {
      id: true,
      userId: true,
      amount: true,
      consumptions: {
        select: {
          amount: true,
          lot: { select: { id: true, pointType: true, expiresAt: true } },
        },
      },
    },
  })

  if (!original) {
    throw errors.notFound('記帳')
  }
  if (original.amount >= 0) {
    throw errors.conflict('消費以外の記帳は取り消せません', {
      ledgerEntryId: params.ledgerEntryId,
    })
  }

  const at = now()
  let paidRestored = 0
  let freeRestored = 0
  let unrestorable = 0

  for (const consumption of original.consumptions) {
    // すでに期限が切れたロットへ戻しても使えないため、戻さない
    if (consumption.lot.expiresAt.getTime() <= at.getTime()) {
      unrestorable += consumption.amount
      continue
    }

    const applied = await incrementLot(tx, consumption.lot.id, consumption.amount)
    if (!applied) {
      unrestorable += consumption.amount
      continue
    }

    if (consumption.lot.pointType === PointType.PAID) {
      paidRestored += consumption.amount
    } else {
      freeRestored += consumption.amount
    }
  }

  const restored = paidRestored + freeRestored

  if (restored === 0) {
    // 戻せる分が無い場合も記帳だけは残す（金額 0 の記帳は CHECK 制約で拒否されるため、
    // ここでは記帳せずに結果だけ返す）
    return { ledgerEntryId: '', restored: 0, unrestorable }
  }

  const balance = await applyBalanceDelta(tx, original.userId, paidRestored, freeRestored)
  if (!balance) {
    throw errors.internal(new Error('取消し時の残高更新に失敗しました'), {
      ledgerEntryId: params.ledgerEntryId,
    })
  }

  const entry = await tx.pointLedgerEntry.create({
    data: {
      userId: original.userId,
      txType: params.txType,
      pointType: resolvePointType(paidRestored, freeRestored),
      amount: restored,
      balanceAfter: balance.paidBalance + balance.freeBalance,
      reason: params.reason,
      sourceType: params.sourceType ?? 'POINT_LEDGER_ENTRY',
      sourceId: params.sourceId ?? original.id,
      createdBy: context.actorId ?? null,
    },
    select: { id: true },
  })

  return { ledgerEntryId: entry.id, restored, unrestorable }
}

/**
 * 実際に使える残高（期限切れを除く）。
 * 抽選の可否判定と画面表示はこちらを使う。
 */
export async function getBalance(
  tx: PrismaTransactionClient,
  userId: string,
): Promise<{ paid: number; free: number; total: number }> {
  const balance = await getSpendableBalance(tx, userId, now())
  return {
    paid: balance.paidBalance,
    free: balance.freeBalance,
    total: balance.paidBalance + balance.freeBalance,
  }
}

/* -------------------------------------------------------------------------- */

const REASON_REQUIRED_TX_TYPES: readonly PointTxType[] = [
  PointTxType.ADJUSTMENT,
  PointTxType.REVERSAL,
]

function requireReasonIfNeeded(txType: PointTxType, reason: string | null | undefined): void {
  if (!REASON_REQUIRED_TX_TYPES.includes(txType)) return
  if (reason && reason.trim().length > 0) return

  // DB の CHECK 制約でも弾かれるが、分かりやすいエラーにするため先に検査する
  throw errors.reasonRequired()
}

function sumBy(breakdown: readonly ConsumeBreakdown[], pointType: PointType): number {
  return breakdown
    .filter((item) => item.pointType === pointType)
    .reduce((sum, item) => sum + item.amount, 0)
}

/** 片方だけが動いたならその種別、両方なら null（内訳は明細を見る） */
function resolvePointType(paid: number, free: number): PointType | null {
  if (paid > 0 && free > 0) return null
  if (paid > 0) return PointType.PAID
  if (free > 0) return PointType.FREE
  return null
}
