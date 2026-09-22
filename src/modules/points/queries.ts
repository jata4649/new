import type { PointTxType, PointType } from '@/generated/prisma/enums.ts'
import { now } from '@/lib/datetime/index.ts'
import { prisma } from '@/server/db.ts'

import { getSpendableBalance } from './repository.ts'

/**
 * ポイントの参照系。
 *
 * 書き込みは ledger.ts のみ。ここは読み取り専用。
 */

export interface PointLotView {
  id: string
  pointType: PointType
  amountIssued: number
  amountRemaining: number
  issuedAt: Date
  expiresAt: Date
  /** 期限までの日数（切り捨て）。0 なら当日中に失効する。 */
  daysUntilExpiry: number
}

export interface PointSummary {
  /** 実際に使える残高（期限切れを除く） */
  spendable: { paid: number; free: number; total: number }
  /**
   * 口座キャッシュの値。失効バッチが走るまで期限切れ分を含むことがあるため、
   * 画面表示には spendable を使う。ここは差分の把握・調査用。
   */
  cached: { paid: number; free: number; total: number }
  /** 有効期限が近い順のロット一覧 */
  lots: PointLotView[]
  /** 30 日以内に失効するポイント */
  expiringSoon: number
}

const EXPIRY_WARNING_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

export async function getPointSummary(userId: string): Promise<PointSummary> {
  const at = now()

  const [spendable, account, lots] = await Promise.all([
    getSpendableBalance(prisma, userId, at),
    prisma.pointAccount.findUnique({
      where: { userId },
      select: { paidBalance: true, freeBalance: true },
    }),
    prisma.pointLot.findMany({
      where: { userId, amountRemaining: { gt: 0 }, expiresAt: { gt: at } },
      select: {
        id: true,
        pointType: true,
        amountIssued: true,
        amountRemaining: true,
        issuedAt: true,
        expiresAt: true,
      },
      orderBy: [{ expiresAt: 'asc' }, { issuedAt: 'asc' }, { id: 'asc' }],
      take: 200,
    }),
  ])

  const warningThreshold = at.getTime() + EXPIRY_WARNING_DAYS * MS_PER_DAY

  const lotViews: PointLotView[] = lots.map((lot) => ({
    ...lot,
    daysUntilExpiry: Math.max(
      0,
      Math.floor((lot.expiresAt.getTime() - at.getTime()) / MS_PER_DAY),
    ),
  }))

  const expiringSoon = lots
    .filter((lot) => lot.expiresAt.getTime() <= warningThreshold)
    .reduce((sum, lot) => sum + lot.amountRemaining, 0)

  const cachedPaid = account?.paidBalance ?? 0
  const cachedFree = account?.freeBalance ?? 0

  return {
    spendable: {
      paid: spendable.paidBalance,
      free: spendable.freeBalance,
      total: spendable.paidBalance + spendable.freeBalance,
    },
    cached: {
      paid: cachedPaid,
      free: cachedFree,
      total: cachedPaid + cachedFree,
    },
    lots: lotViews,
    expiringSoon,
  }
}

export interface PointHistoryEntry {
  id: string
  txType: PointTxType
  pointType: PointType | null
  amount: number
  balanceAfter: number
  reason: string | null
  sourceType: string | null
  sourceId: string | null
  createdAt: Date
}

export interface PointHistoryResult {
  items: PointHistoryEntry[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export async function getPointHistory(
  userId: string,
  options: { page: number; perPage: number; txType?: PointTxType },
): Promise<PointHistoryResult> {
  const where = {
    userId,
    ...(options.txType ? { txType: options.txType } : {}),
  }

  const [total, items] = await Promise.all([
    prisma.pointLedgerEntry.count({ where }),
    prisma.pointLedgerEntry.findMany({
      where,
      select: {
        id: true,
        txType: true,
        pointType: true,
        amount: true,
        balanceAfter: true,
        reason: true,
        sourceType: true,
        sourceId: true,
        createdAt: true,
      },
      // 同一時刻の並びが安定するよう id も指定する
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (options.page - 1) * options.perPage,
      take: options.perPage,
    }),
  ])

  return {
    items,
    total,
    page: options.page,
    perPage: options.perPage,
    totalPages: Math.max(1, Math.ceil(total / options.perPage)),
  }
}

export interface PaymentHistoryEntry {
  id: string
  providerPaymentId: string
  amountYen: number
  grantPoints: number
  status: string
  confirmedAt: Date | null
  createdAt: Date
}

export async function getPaymentHistory(
  userId: string,
  limit = 50,
): Promise<PaymentHistoryEntry[]> {
  return prisma.paymentTransaction.findMany({
    where: { userId },
    select: {
      id: true,
      providerPaymentId: true,
      amountYen: true,
      grantPoints: true,
      status: true,
      confirmedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}
