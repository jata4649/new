import type { EffectTier, PrizeStatus } from '@/generated/prisma/enums.ts'
import { errors } from '@/lib/api/errors.ts'
import { prisma } from '@/server/db.ts'

import type { DrawHistoryQuery } from './schema.ts'

/**
 * 抽選結果の参照。
 *
 * 要件:「リロードしても結果が失われない」「通信が切れても再抽選されない」
 *   結果は演出より先に DB へ確定しているので、ここは単純な読み出しで足りる。
 *
 * 【重要】他人の抽選結果を読めないようにする。
 *   すべての関数が userId を必須で受け取り、WHERE 句に必ず含める。
 *   「ID を知っていれば読める」構造にしない（要件: 認可はサーバー側で行う）。
 */

export interface DrawResultItem {
  sequence: number
  userPrizeId: string | null
  name: string
  tierCode: string
  tierName: string
  effectTier: EffectTier
  exchangePoints: number
  imageKey: string | null
  rarity: string | null
  /** 当選後にユーザーが選んだ処理の状態 */
  prizeStatus: PrizeStatus | null
}

export interface DrawDetail {
  id: string
  campaignName: string
  campaignSlug: string
  drawCount: number
  unitPricePoints: number
  totalPricePoints: number
  createdAt: Date
  results: DrawResultItem[]
}

/**
 * 抽選 1 回分の結果を取得する。
 *
 * 本人のものだけを返す。存在しない ID と他人の ID を区別せず 404 にする
 * （ID の存在を推測させないため）。
 */
export async function getDrawDetail(
  drawTransactionId: string,
  userId: string,
): Promise<DrawDetail> {
  const transaction = await prisma.drawTransaction.findFirst({
    where: { id: drawTransactionId, userId },
    select: {
      id: true,
      drawCount: true,
      unitPricePoints: true,
      totalPricePoints: true,
      createdAt: true,
      campaign: { select: { name: true, slug: true } },
      results: {
        select: {
          sequence: true,
          tierCodeSnapshot: true,
          tierNameSnapshot: true,
          effectTier: true,
          exchangePoints: true,
          cardNameSnapshot: true,
          raritySnapshot: true,
          imageKeySnapshot: true,
          // slotId は返さない。どのスロットが出たか分かると
          // 抽選順の推測材料になるため。
          userPrize: { select: { id: true, status: true } },
        },
        orderBy: { sequence: 'asc' },
      },
    },
  })

  if (!transaction) {
    throw errors.notFound('抽選結果')
  }

  return {
    id: transaction.id,
    campaignName: transaction.campaign.name,
    campaignSlug: transaction.campaign.slug,
    drawCount: transaction.drawCount,
    unitPricePoints: transaction.unitPricePoints,
    totalPricePoints: transaction.totalPricePoints,
    createdAt: transaction.createdAt,
    results: transaction.results.map((result) => ({
      sequence: result.sequence,
      userPrizeId: result.userPrize?.id ?? null,
      name: result.cardNameSnapshot,
      tierCode: result.tierCodeSnapshot,
      tierName: result.tierNameSnapshot,
      effectTier: result.effectTier,
      exchangePoints: result.exchangePoints,
      imageKey: result.imageKeySnapshot,
      rarity: result.raritySnapshot,
      prizeStatus: result.userPrize?.status ?? null,
    })),
  }
}

export interface DrawHistoryItem {
  id: string
  campaignName: string
  campaignSlug: string
  drawCount: number
  totalPricePoints: number
  createdAt: Date
  /** 一覧での見出し用。最上位の演出ランク。 */
  topEffectTier: EffectTier | null
  /** まだ交換も発送申請もしていない商品の件数 */
  undecidedCount: number
}

export interface DrawHistoryResult {
  items: DrawHistoryItem[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

/** 演出ランクの強さ。一覧の見出しに使う代表ランクを決めるため。 */
const EFFECT_TIER_RANK: Record<EffectTier, number> = {
  JACKPOT: 5,
  RAINBOW: 4,
  GOLD: 3,
  BLUE: 2,
  NORMAL: 1,
}

export async function listUserDraws(
  userId: string,
  query: DrawHistoryQuery,
): Promise<DrawHistoryResult> {
  const where = { userId }

  const [total, transactions] = await Promise.all([
    prisma.drawTransaction.count({ where }),
    prisma.drawTransaction.findMany({
      where,
      select: {
        id: true,
        drawCount: true,
        totalPricePoints: true,
        createdAt: true,
        campaign: { select: { name: true, slug: true } },
        results: {
          select: { effectTier: true, userPrize: { select: { status: true } } },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    }),
  ])

  return {
    items: transactions.map((transaction) => {
      const topEffectTier = transaction.results.reduce<EffectTier | null>((best, result) => {
        if (!best) return result.effectTier
        return EFFECT_TIER_RANK[result.effectTier] > EFFECT_TIER_RANK[best]
          ? result.effectTier
          : best
      }, null)

      return {
        id: transaction.id,
        campaignName: transaction.campaign.name,
        campaignSlug: transaction.campaign.slug,
        drawCount: transaction.drawCount,
        totalPricePoints: transaction.totalPricePoints,
        createdAt: transaction.createdAt,
        topEffectTier,
        undecidedCount: transaction.results.filter(
          (result) => result.userPrize?.status === 'UNDECIDED',
        ).length,
      }
    }),
    total,
    page: query.page,
    perPage: query.perPage,
    totalPages: Math.max(1, Math.ceil(total / query.perPage)),
  }
}

/* -------------------------------------------------------------------------- */
/* 管理画面                                                                    */
/* -------------------------------------------------------------------------- */

export interface AdminDrawListItem {
  id: string
  userEmail: string
  userId: string
  campaignName: string
  campaignSlug: string
  drawCount: number
  totalPricePoints: number
  createdAt: Date
  /** 出たランクコード（重複を含む） */
  tierCodes: string[]
}

export interface AdminDrawListQuery {
  page: number
  perPage: number
  campaignSlug?: string | undefined
  userEmail?: string | undefined
}

/**
 * 抽選履歴（管理画面）。
 *
 * 【重要】スロット ID と抽選順は出さない。
 *   出てしまうと、内部関係者が「次に何が出るか」を逆算できてしまう。
 *   調査に必要なのは「誰が・いつ・いくらで・何が出たか」なので、それだけを返す。
 */
export async function listDrawsForAdmin(query: AdminDrawListQuery): Promise<{
  items: AdminDrawListItem[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  const where = {
    ...(query.campaignSlug ? { campaign: { slug: query.campaignSlug } } : {}),
    ...(query.userEmail
      ? { user: { email: { contains: query.userEmail, mode: 'insensitive' as const } } }
      : {}),
  }

  const [total, transactions] = await Promise.all([
    prisma.drawTransaction.count({ where }),
    prisma.drawTransaction.findMany({
      where,
      select: {
        id: true,
        drawCount: true,
        totalPricePoints: true,
        createdAt: true,
        user: { select: { id: true, email: true } },
        campaign: { select: { name: true, slug: true } },
        results: { select: { tierCodeSnapshot: true }, orderBy: { sequence: 'asc' } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    }),
  ])

  return {
    items: transactions.map((transaction) => ({
      id: transaction.id,
      userId: transaction.user.id,
      userEmail: transaction.user.email,
      campaignName: transaction.campaign.name,
      campaignSlug: transaction.campaign.slug,
      drawCount: transaction.drawCount,
      totalPricePoints: transaction.totalPricePoints,
      createdAt: transaction.createdAt,
      tierCodes: transaction.results.map((result) => result.tierCodeSnapshot),
    })),
    total,
    page: query.page,
    perPage: query.perPage,
    totalPages: Math.max(1, Math.ceil(total / query.perPage)),
  }
}

/**
 * ユーザーがそのオリパをあと何口引けるかを返す。
 *
 * 抽選画面で「上限に達しています」を事前に表示するために使う。
 * これは表示のための値であり、実際の判定は抽選トランザクション内の
 * 条件付き加算が行う（画面の値は古くなりうるため）。
 */
export async function getRemainingDrawQuota(
  userId: string,
  campaignId: string,
  perUserLimit: number | null,
): Promise<number | null> {
  if (perUserLimit === null) return null

  const counter = await prisma.userCampaignCounter.findUnique({
    where: { userId_campaignId: { userId, campaignId } },
    select: { drawnCount: true },
  })

  return Math.max(0, perUserLimit - (counter?.drawnCount ?? 0))
}
