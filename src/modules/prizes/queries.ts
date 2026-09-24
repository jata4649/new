import { PrizeStatus, type EffectTier } from '@/generated/prisma/enums.ts'
import { errors } from '@/lib/api/errors.ts'
import { prisma } from '@/server/db.ts'

import type { PrizeListQuery } from './schema.ts'

/**
 * 当選商品の参照。
 *
 * 【重要】すべての関数が userId を必須で受け取り、WHERE 句に必ず含める。
 *   「ID を知っていれば読める」構造にしない。
 *
 * 表示に使う値はすべて抽選時のスナップショット。
 * 在庫マスタが変わっても、手元の当選商品の見え方は変わらない。
 */

export interface UserPrizeItem {
  id: string
  name: string
  effectTier: EffectTier
  exchangePoints: number
  imageKey: string | null
  status: PrizeStatus
  shippable: boolean
  /** 物理カードなら true。汎用景品（ポイント還元）なら false。 */
  isPhysical: boolean
  createdAt: Date
  exchangedAt: Date | null
  /** この商品が出た抽選。結果画面へ戻れるようにする。 */
  drawTransactionId: string
  campaignName: string
}

export interface UserPrizeListResult {
  items: UserPrizeItem[]
  total: number
  page: number
  perPage: number
  totalPages: number
  /** まだ交換も発送申請もしていない件数（絞り込みに関わらず全体の件数） */
  undecidedTotal: number
}

/**
 * 当選商品一覧。
 *
 * 未選択（UNDECIDED）を先頭に出す。利用者が最初に見たいのは
 * 「まだ決めていないもの」であり、処理済みの履歴ではないため。
 */
export async function listUserPrizes(
  userId: string,
  query: PrizeListQuery,
): Promise<UserPrizeListResult> {
  const where = {
    userId,
    ...(query.status ? { status: query.status } : {}),
  }

  const [total, undecidedTotal, prizes] = await Promise.all([
    prisma.userPrize.count({ where }),
    prisma.userPrize.count({ where: { userId, status: PrizeStatus.UNDECIDED } }),
    prisma.userPrize.findMany({
      where,
      select: {
        id: true,
        nameSnapshot: true,
        effectTier: true,
        exchangePoints: true,
        imageKeySnapshot: true,
        status: true,
        shippable: true,
        inventoryId: true,
        createdAt: true,
        exchangedAt: true,
        drawResult: {
          select: {
            drawTransactionId: true,
            drawTransaction: { select: { campaign: { select: { name: true } } } },
          },
        },
      },
      // UNDECIDED を先に。同順位内は新しい順。
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    }),
  ])

  return {
    items: prizes.map((prize) => ({
      id: prize.id,
      name: prize.nameSnapshot,
      effectTier: prize.effectTier,
      exchangePoints: prize.exchangePoints,
      imageKey: prize.imageKeySnapshot,
      status: prize.status,
      shippable: prize.shippable,
      isPhysical: prize.inventoryId !== null,
      createdAt: prize.createdAt,
      exchangedAt: prize.exchangedAt,
      drawTransactionId: prize.drawResult.drawTransactionId,
      campaignName: prize.drawResult.drawTransaction.campaign.name,
    })),
    total,
    undecidedTotal,
    page: query.page,
    perPage: query.perPage,
    totalPages: Math.max(1, Math.ceil(total / query.perPage)),
  }
}

/** 当選商品 1 件。本人のものだけを返す。 */
export async function getUserPrize(prizeId: string, userId: string): Promise<UserPrizeItem> {
  const prize = await prisma.userPrize.findFirst({
    where: { id: prizeId, userId },
    select: {
      id: true,
      nameSnapshot: true,
      effectTier: true,
      exchangePoints: true,
      imageKeySnapshot: true,
      status: true,
      shippable: true,
      inventoryId: true,
      createdAt: true,
      exchangedAt: true,
      drawResult: {
        select: {
          drawTransactionId: true,
          drawTransaction: { select: { campaign: { select: { name: true } } } },
        },
      },
    },
  })

  if (!prize) {
    throw errors.notFound('当選商品')
  }

  return {
    id: prize.id,
    name: prize.nameSnapshot,
    effectTier: prize.effectTier,
    exchangePoints: prize.exchangePoints,
    imageKey: prize.imageKeySnapshot,
    status: prize.status,
    shippable: prize.shippable,
    isPhysical: prize.inventoryId !== null,
    createdAt: prize.createdAt,
    exchangedAt: prize.exchangedAt,
    drawTransactionId: prize.drawResult.drawTransactionId,
    campaignName: prize.drawResult.drawTransaction.campaign.name,
  }
}
