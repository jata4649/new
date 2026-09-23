import { CampaignStatus, type EffectTier } from '@/generated/prisma/enums.ts'
import { errors } from '@/lib/api/errors.ts'
import { now } from '@/lib/datetime/index.ts'
import { formatOdds, formatPercent, ratio, type Ratio } from '@/lib/money/points.ts'
import { prisma } from '@/server/db.ts'

/**
 * ユーザー向けのオリパ参照。
 *
 * 【重要】draw_order と slot_order_seed は絶対に含めない。
 *   これらが分かると「次に何が出るか」を計算できてしまう。
 *   select を明示し、うっかり全カラムを返さないようにしている。
 */

/** ユーザーへ見せる販売状態 */
export type PublicSaleState = 'ON_SALE' | 'SCHEDULED' | 'SOLD_OUT' | 'ENDED' | 'SUSPENDED'

export interface OripaListItem {
  id: string
  slug: string
  name: string
  thumbnailKey: string | null
  pricePoints: number
  totalSlots: number
  remainingSlots: number
  saleState: PublicSaleState
  salesStartAt: Date
  salesEndAt: Date
  /** 最上位ランクの演出（一覧のバッジ表示用） */
  topEffectTier: EffectTier | null
}

/**
 * 表示用の販売状態を求める。
 *
 * DB の status だけでは「販売期間は始まっているが SCHEDULED のまま」
 * といったズレが出うるため、時刻と残り口数も見て決める。
 */
export function resolveSaleState(campaign: {
  status: CampaignStatus
  salesStartAt: Date
  salesEndAt: Date
  remainingSlots: number
}): PublicSaleState {
  const at = now()

  if (campaign.status === CampaignStatus.SUSPENDED) return 'SUSPENDED'
  if (campaign.status === CampaignStatus.SOLD_OUT || campaign.remainingSlots <= 0) {
    return 'SOLD_OUT'
  }
  if (campaign.status === CampaignStatus.ENDED || campaign.salesEndAt <= at) return 'ENDED'
  if (campaign.salesStartAt > at) return 'SCHEDULED'
  if (campaign.status === CampaignStatus.ACTIVE) return 'ON_SALE'
  return 'SCHEDULED'
}

/** ユーザーへ見せてよい状態（下書き・アーカイブは除く） */
const PUBLIC_STATUSES: readonly CampaignStatus[] = [
  CampaignStatus.SCHEDULED,
  CampaignStatus.ACTIVE,
  CampaignStatus.SUSPENDED,
  CampaignStatus.SOLD_OUT,
  CampaignStatus.ENDED,
]

export async function listPublicOripas(): Promise<OripaListItem[]> {
  const campaigns = await prisma.oripaCampaign.findMany({
    where: {
      deletedAt: null,
      status: { in: [...PUBLIC_STATUSES] },
      // 公開済みのものだけ
      publishedAt: { not: null },
    },
    select: {
      id: true,
      slug: true,
      name: true,
      thumbnailKey: true,
      pricePoints: true,
      totalSlots: true,
      remainingSlots: true,
      status: true,
      salesStartAt: true,
      salesEndAt: true,
      tiers: {
        select: { effectTier: true },
        orderBy: { displayOrder: 'asc' },
        take: 1,
      },
    },
    orderBy: [{ salesStartAt: 'desc' }, { id: 'desc' }],
    take: 100,
  })

  return campaigns.map((campaign) => ({
    id: campaign.id,
    slug: campaign.slug,
    name: campaign.name,
    thumbnailKey: campaign.thumbnailKey,
    pricePoints: campaign.pricePoints,
    totalSlots: campaign.totalSlots,
    remainingSlots: campaign.remainingSlots,
    saleState: resolveSaleState(campaign),
    salesStartAt: campaign.salesStartAt,
    salesEndAt: campaign.salesEndAt,
    topEffectTier: campaign.tiers[0]?.effectTier ?? null,
  }))
}

export interface TierOdds {
  code: string
  name: string
  effectTier: EffectTier
  /** このランクの総口数 */
  slotCount: number
  /** まだ引かれていない口数（＝当たり残数） */
  remainingCount: number
  /** 当選確率。整数比のまま保持し、表示時に整形する。 */
  odds: Ratio
  oddsPercent: string
  oddsFraction: string
  /** このランクの代表的な交換ポイント（最大値） */
  maxExchangePoints: number
}

export interface TopPrize {
  name: string
  imageKey: string | null
  exchangePoints: number
  effectTier: EffectTier
  tierCode: string
  /** すでに引かれているか */
  drawn: boolean
}

export interface OripaDetail extends OripaListItem {
  description: string | null
  perUserLimit: number | null
  effectSetKey: string
  /** 最低交換ポイント（全スロット中の最小値） */
  minExchangePoints: number
  tiers: TierOdds[]
  /** 上位景品（上位 2 ランクから最大 12 件） */
  topPrizes: TopPrize[]
  /** 公開時に記録したコミットハッシュ（公正性の検証用に公開する） */
  slotOrderCommit: string | null
  /** 販売終了後に公開されるシード。未公開なら null。 */
  revealedSeed: string | null
  /**
   * 抽選順に並べたランクコード列。シード公開後にのみ返す。
   *
   * シードだけでは第三者はハッシュを再計算できない。
   * コミットは SHA-256(campaignId | serverSeed | ランクコード列) なので、
   * 検証にはこの列も要る。販売中に出すと次に出るものが分かってしまうため、
   * 公開後に限って返す。
   */
  revealedTierCodes: string[] | null
  /** 検証の手順に使う campaignId。シード公開後にのみ返す。 */
  revealedCampaignId: string | null
}

export async function getPublicOripaDetail(slug: string): Promise<OripaDetail> {
  const campaign = await prisma.oripaCampaign.findFirst({
    where: {
      slug,
      deletedAt: null,
      publishedAt: { not: null },
      status: { in: [...PUBLIC_STATUSES] },
    },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      thumbnailKey: true,
      pricePoints: true,
      totalSlots: true,
      remainingSlots: true,
      perUserLimit: true,
      effectSetKey: true,
      status: true,
      salesStartAt: true,
      salesEndAt: true,
      slotOrderCommit: true,
      slotOrderRevealedAt: true,
      slotOrderSeed: true,
      tiers: {
        select: {
          id: true,
          code: true,
          name: true,
          effectTier: true,
          slotCount: true,
          displayOrder: true,
        },
        orderBy: { displayOrder: 'asc' },
      },
    },
  })

  if (!campaign) {
    throw errors.notFound('オリパ')
  }

  const isRevealed = campaign.slotOrderRevealedAt !== null

  /*
   * 検証用のランクコード列。
   *
   * 公開前は絶対に引かない。引いてしまうと、返さないつもりでも
   * どこかの経路で外へ出る余地が生まれる。
   * 公開後は「すべて引き終わった後の記録」なので、出しても先読みには使えない。
   */
  const revealedTierCodes = isRevealed
    ? await prisma.oripaSlot
        .findMany({
          where: { campaignId: campaign.id },
          select: { tier: { select: { code: true } } },
          orderBy: { drawOrder: 'asc' },
        })
        .then((rows) => rows.map((row) => row.tier.code))
    : null

  // ランクごとの残数。当たり残数の表示は要件の中核。
  const remainingByTier = await prisma.oripaSlot.groupBy({
    by: ['tierId'],
    where: { campaignId: campaign.id, status: 'AVAILABLE' },
    _count: { _all: true },
  })
  const remainingMap = new Map(remainingByTier.map((row) => [row.tierId, row._count._all]))

  const maxExchangeByTier = await prisma.oripaSlot.groupBy({
    by: ['tierId'],
    where: { campaignId: campaign.id },
    _max: { exchangePoints: true },
    _min: { exchangePoints: true },
  })
  const maxExchangeMap = new Map(
    maxExchangeByTier.map((row) => [row.tierId, row._max.exchangePoints ?? 0]),
  )
  const minExchangePoints = Math.min(
    ...maxExchangeByTier.map((row) => row._min.exchangePoints ?? 0),
  )

  const tiers: TierOdds[] = campaign.tiers.map((tier) => {
    const odds = ratio(tier.slotCount, campaign.totalSlots)
    return {
      code: tier.code,
      name: tier.name,
      effectTier: tier.effectTier,
      slotCount: tier.slotCount,
      remainingCount: remainingMap.get(tier.id) ?? 0,
      odds,
      oddsPercent: formatPercent(odds),
      oddsFraction: formatOdds(odds),
      maxExchangePoints: maxExchangeMap.get(tier.id) ?? 0,
    }
  })

  // 上位景品。上位 2 ランクのスロットから、交換ポイントの高い順に見せる。
  const topTierIds = campaign.tiers.slice(0, 2).map((tier) => tier.id)
  const topSlots =
    topTierIds.length > 0
      ? await prisma.oripaSlot.findMany({
          where: { campaignId: campaign.id, tierId: { in: topTierIds } },
          select: {
            status: true,
            exchangePoints: true,
            tier: { select: { code: true, effectTier: true } },
            inventory: { select: { cardName: true, frontImageKey: true } },
            genericPrize: { select: { name: true, imageKey: true } },
          },
          orderBy: { exchangePoints: 'desc' },
          take: 12,
        })
      : []

  const topPrizes: TopPrize[] = topSlots.map((slot) => ({
    name: slot.inventory?.cardName ?? slot.genericPrize?.name ?? '景品',
    imageKey: slot.inventory?.frontImageKey ?? slot.genericPrize?.imageKey ?? null,
    exchangePoints: slot.exchangePoints,
    effectTier: slot.tier.effectTier,
    tierCode: slot.tier.code,
    drawn: slot.status === 'DRAWN',
  }))

  return {
    id: campaign.id,
    slug: campaign.slug,
    name: campaign.name,
    description: campaign.description,
    thumbnailKey: campaign.thumbnailKey,
    pricePoints: campaign.pricePoints,
    totalSlots: campaign.totalSlots,
    remainingSlots: campaign.remainingSlots,
    perUserLimit: campaign.perUserLimit,
    effectSetKey: campaign.effectSetKey,
    saleState: resolveSaleState(campaign),
    salesStartAt: campaign.salesStartAt,
    salesEndAt: campaign.salesEndAt,
    topEffectTier: campaign.tiers[0]?.effectTier ?? null,
    minExchangePoints: Number.isFinite(minExchangePoints) ? minExchangePoints : 0,
    tiers,
    topPrizes,
    slotOrderCommit: campaign.slotOrderCommit,
    // シードは「公開した」と明示された場合だけ返す。
    // 販売中に返してしまうと、次に何が出るか計算できてしまう。
    revealedSeed: isRevealed ? campaign.slotOrderSeed : null,
    revealedTierCodes: revealedTierCodes,
    revealedCampaignId: isRevealed ? campaign.id : null,
  }
}
