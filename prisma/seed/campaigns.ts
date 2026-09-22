import type { PrismaClient } from '../../src/generated/prisma/client.ts'
import { EffectTier } from '../../src/generated/prisma/enums.ts'
import type { PrismaTransactionClient } from '../../src/server/db.ts'
import { createOripa, publishOripa } from '../../src/modules/oripa/service.ts'
import { generateSlots } from '../../src/modules/oripa/slots.ts'

/**
 * 動作確認用のオリパを作る。
 *
 * 実装した API と同じサービス関数（createOripa → generateSlots → publishOripa）
 * を通す。seed 専用の近道を作ると、seed だけ通って本番経路が壊れている
 * という状態に気付けなくなるため。
 *
 * 作るもの:
 *   - 販売中 3 種（価格帯と口数を変えてある）
 *   - 販売前 1 種（販売開始が未来）
 *   - 完売 1 種（全スロットが抽選済み）
 *
 * 【Phase 4 時点の制限】
 *   完売オリパは、スロットを DRAWN にしてユーザーを紐付けるだけで、
 *   draw_transactions / draw_results / user_prizes は作らない。
 *   これらは抽選処理（Phase 5）が作るものであり、
 *   seed が独自に組み立てると本物の抽選との差異に気付けなくなるため。
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

interface TierPlan {
  code: string
  name: string
  effectTier: EffectTier
  slotCount: number
  /** このランクへ割り当てる物理在庫の数（残りは汎用景品で埋める） */
  inventoryCount: number
  /** 不足分を埋める汎用景品のコード */
  genericPrizeCode: string
}

interface CampaignPlan {
  slug: string
  name: string
  description: string
  pricePoints: number
  totalSlots: number
  perUserLimit: number | null
  /** 現在時刻からのオフセット（ミリ秒） */
  startOffset: number
  endOffset: number
  tiers: TierPlan[]
  /** 全スロットを抽選済みにするか（完売オリパの確認用） */
  markSoldOut?: boolean
}

const CAMPAIGN_PLANS: CampaignPlan[] = [
  {
    slug: 'sample-standard-01',
    name: 'サンプル・スタンダードオリパ',
    description:
      '開発確認用のオリパです。景品はすべて架空のサンプルで、現金での購入・買取りは行いません。',
    pricePoints: 500,
    totalSlots: 100,
    perUserLimit: null,
    startOffset: -2 * DAY,
    endOffset: 25 * DAY,
    tiers: [
      {
        code: 'S',
        name: 'S賞',
        effectTier: EffectTier.JACKPOT,
        slotCount: 1,
        inventoryCount: 1,
        genericPrizeCode: 'GENERIC-POINT-1000',
      },
      {
        code: 'A',
        name: 'A賞',
        effectTier: EffectTier.GOLD,
        slotCount: 9,
        inventoryCount: 9,
        genericPrizeCode: 'GENERIC-POINT-300',
      },
      {
        code: 'B',
        name: 'B賞',
        effectTier: EffectTier.NORMAL,
        slotCount: 90,
        inventoryCount: 0,
        genericPrizeCode: 'GENERIC-POINT-100',
      },
    ],
  },
  {
    slug: 'sample-premium-01',
    name: 'サンプル・プレミアムオリパ',
    description: '高額帯の動作確認用。1 人あたりの購入上限を設定してあります。',
    pricePoints: 3_000,
    totalSlots: 50,
    perUserLimit: 10,
    startOffset: -1 * DAY,
    endOffset: 14 * DAY,
    tiers: [
      {
        code: 'S',
        name: 'S賞',
        effectTier: EffectTier.JACKPOT,
        slotCount: 1,
        inventoryCount: 1,
        genericPrizeCode: 'GENERIC-POINT-1000',
      },
      {
        code: 'A',
        name: 'A賞',
        effectTier: EffectTier.RAINBOW,
        slotCount: 4,
        inventoryCount: 4,
        genericPrizeCode: 'GENERIC-POINT-1000',
      },
      {
        code: 'B',
        name: 'B賞',
        effectTier: EffectTier.BLUE,
        slotCount: 15,
        inventoryCount: 15,
        genericPrizeCode: 'GENERIC-POINT-300',
      },
      {
        code: 'C',
        name: 'C賞',
        effectTier: EffectTier.NORMAL,
        slotCount: 30,
        inventoryCount: 0,
        genericPrizeCode: 'GENERIC-POINT-300',
      },
    ],
  },
  {
    slug: 'sample-light-01',
    name: 'サンプル・ライトオリパ',
    description: '低価格・多口数の動作確認用。残り口数の表示確認に使います。',
    pricePoints: 100,
    totalSlots: 200,
    perUserLimit: null,
    startOffset: -3 * HOUR,
    endOffset: 30 * DAY,
    tiers: [
      {
        code: 'A',
        name: 'A賞',
        effectTier: EffectTier.GOLD,
        slotCount: 2,
        inventoryCount: 2,
        genericPrizeCode: 'GENERIC-POINT-1000',
      },
      {
        code: 'B',
        name: 'B賞',
        effectTier: EffectTier.BLUE,
        slotCount: 18,
        inventoryCount: 18,
        genericPrizeCode: 'GENERIC-POINT-300',
      },
      {
        code: 'C',
        name: 'C賞',
        effectTier: EffectTier.NORMAL,
        slotCount: 180,
        inventoryCount: 0,
        genericPrizeCode: 'GENERIC-POINT-50',
      },
    ],
  },
  {
    slug: 'sample-scheduled-01',
    name: 'サンプル・販売前オリパ',
    description: '販売開始前の表示確認用。開始日時になるまで抽選できません。',
    pricePoints: 1_000,
    totalSlots: 100,
    perUserLimit: null,
    startOffset: 3 * DAY,
    endOffset: 20 * DAY,
    tiers: [
      {
        code: 'S',
        name: 'S賞',
        effectTier: EffectTier.JACKPOT,
        slotCount: 1,
        inventoryCount: 1,
        genericPrizeCode: 'GENERIC-POINT-1000',
      },
      {
        code: 'A',
        name: 'A賞',
        effectTier: EffectTier.GOLD,
        slotCount: 9,
        inventoryCount: 9,
        genericPrizeCode: 'GENERIC-POINT-300',
      },
      {
        code: 'B',
        name: 'B賞',
        effectTier: EffectTier.NORMAL,
        slotCount: 90,
        inventoryCount: 0,
        genericPrizeCode: 'GENERIC-POINT-100',
      },
    ],
  },
  {
    slug: 'sample-soldout-01',
    name: 'サンプル・完売オリパ',
    description: '完売時の表示確認用。全口が抽選済みです。',
    pricePoints: 800,
    totalSlots: 30,
    perUserLimit: null,
    startOffset: -10 * DAY,
    endOffset: 10 * DAY,
    markSoldOut: true,
    tiers: [
      {
        code: 'S',
        name: 'S賞',
        effectTier: EffectTier.JACKPOT,
        slotCount: 1,
        inventoryCount: 1,
        genericPrizeCode: 'GENERIC-POINT-1000',
      },
      {
        code: 'A',
        name: 'A賞',
        effectTier: EffectTier.GOLD,
        slotCount: 4,
        inventoryCount: 4,
        genericPrizeCode: 'GENERIC-POINT-300',
      },
      {
        code: 'B',
        name: 'B賞',
        effectTier: EffectTier.NORMAL,
        slotCount: 25,
        inventoryCount: 0,
        genericPrizeCode: 'GENERIC-POINT-100',
      },
    ],
  },
]

export const GENERIC_PRIZES = [
  {
    code: 'GENERIC-POINT-50',
    name: 'ポイント還元アイテム（50P）',
    description: '物理カードの代わりにポイントへ交換できる景品です。発送の対象外です。',
    exchangePoints: 50,
    shippable: false,
  },
  {
    code: 'GENERIC-POINT-100',
    name: 'ポイント還元アイテム（100P）',
    description: '物理カードの代わりにポイントへ交換できる景品です。発送の対象外です。',
    exchangePoints: 100,
    shippable: false,
  },
  {
    code: 'GENERIC-POINT-300',
    name: 'ポイント還元アイテム（300P）',
    description: '物理カードの代わりにポイントへ交換できる景品です。発送の対象外です。',
    exchangePoints: 300,
    shippable: false,
  },
  {
    code: 'GENERIC-POINT-1000',
    name: 'ポイント還元アイテム（1,000P）',
    description: '物理カードの代わりにポイントへ交換できる景品です。発送の対象外です。',
    exchangePoints: 1_000,
    shippable: false,
  },
] as const

/**
 * 割当に使う在庫を確保する。
 *
 * 交換ポイントの高い順に取り、上位ランクから先に使う。
 * 「S 賞なのに B 賞より安い」という不自然なデータにしないため。
 */
async function takeInventories(
  tx: PrismaTransactionClient,
  used: Set<string>,
  count: number,
): Promise<string[]> {
  if (count === 0) return []

  const candidates = await tx.inventory.findMany({
    where: { deletedAt: null, status: 'AVAILABLE', slot: { is: null } },
    select: { id: true },
    orderBy: [{ exchangePoints: 'desc' }, { id: 'asc' }],
    take: count + used.size,
  })

  const picked = candidates
    .map((row) => row.id)
    .filter((id) => !used.has(id))
    .slice(0, count)

  if (picked.length < count) {
    throw new Error(
      `割当可能な在庫が足りません（必要 ${count} 件 / 取得 ${picked.length} 件）。` +
        'seed のカード枚数を増やすか、オリパの構成を見直してください。',
    )
  }

  for (const id of picked) used.add(id)
  return picked
}

async function seedOneCampaign(
  prisma: PrismaClient,
  plan: CampaignPlan,
  actorId: string,
): Promise<'created' | 'skipped'> {
  const existing = await prisma.oripaCampaign.findUnique({
    where: { slug: plan.slug },
    select: { id: true },
  })
  if (existing) return 'skipped'

  const at = Date.now()
  const salesStartAt = new Date(at + plan.startOffset).toISOString()
  const salesEndAt = new Date(at + plan.endOffset).toISOString()

  await prisma.$transaction(
    async (tx) => {
      const created = await createOripa(
        tx,
        {
          slug: plan.slug,
          name: plan.name,
          description: plan.description,
          thumbnailKey: `placeholder:SR:${(plan.totalSlots * 7) % 360}:front`,
          pricePoints: plan.pricePoints,
          totalSlots: plan.totalSlots,
          perUserLimit: plan.perUserLimit,
          salesStartAt,
          salesEndAt,
          effectSetKey: 'default',
          tiers: plan.tiers.map((tier, index) => ({
            code: tier.code,
            name: tier.name,
            effectTier: tier.effectTier,
            slotCount: tier.slotCount,
            displayOrder: index,
          })),
        },
        { id: actorId },
        { requestId: 'seed' },
      )

      // 上位ランクから順に、高額の在庫を割り当てる
      const used = new Set<string>()
      const allocations: {
        tierCode: string
        inventoryIds: string[]
        genericPrizeCode: string | null
      }[] = []

      for (const tier of plan.tiers) {
        allocations.push({
          tierCode: tier.code,
          inventoryIds: await takeInventories(tx, used, tier.inventoryCount),
          genericPrizeCode: tier.genericPrizeCode,
        })
      }

      await generateSlots(tx, created.id, { allocations })
      await publishOripa(tx, created.id, { id: actorId }, { requestId: 'seed' })

      if (plan.markSoldOut) {
        await markCampaignSoldOut(tx, created.id)
      }
    },
    // 200 口のスロット生成があるため既定の 5 秒では足りない
    { timeout: 60_000 },
  )

  return 'created'
}

/**
 * 全スロットを抽選済みにして完売状態にする。
 *
 * 公開後のスロットは AVAILABLE → DRAWN への遷移だけが DB トリガで許可されている。
 * ここではその遷移だけを行い、景品の中身と抽選順には触れない。
 */
async function markCampaignSoldOut(
  tx: PrismaTransactionClient,
  campaignId: string,
): Promise<void> {
  const winners = await tx.user.findMany({
    where: { role: 'USER', status: 'ACTIVE', deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })

  if (winners.length === 0) {
    throw new Error('完売オリパを作るには一般ユーザーが 1 名以上必要です')
  }

  const slots = await tx.oripaSlot.findMany({
    where: { campaignId },
    select: { id: true, inventoryId: true },
    orderBy: { slotNumber: 'asc' },
  })

  const drawnAt = new Date()
  for (const [index, slot] of slots.entries()) {
    const winner = winners[index % winners.length]
    if (!winner) continue

    await tx.oripaSlot.update({
      where: { id: slot.id },
      data: { status: 'DRAWN', drawnByUserId: winner.id, drawnAt },
    })

    // 物理在庫は「当選済み」へ。発送申請か交換が行われるまでこの状態。
    if (slot.inventoryId) {
      await tx.inventory.update({
        where: { id: slot.inventoryId },
        data: { status: 'WON' },
      })
    }
  }

  await tx.oripaCampaign.update({
    where: { id: campaignId },
    data: { remainingSlots: 0, status: 'SOLD_OUT', soldOutAt: drawnAt },
  })
}

export async function seedCampaigns(prisma: PrismaClient): Promise<void> {
  const admin = await prisma.user.findFirst({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })

  if (!admin) {
    throw new Error('オリパを作成する管理者が見つかりません')
  }

  let created = 0
  let skipped = 0

  for (const plan of CAMPAIGN_PLANS) {
    const result = await seedOneCampaign(prisma, plan, admin.id)
    if (result === 'created') {
      created += 1
      console.log(`    ${plan.slug}（${plan.totalSlots} 口）を作成しました`)
    } else {
      skipped += 1
    }
  }

  console.log(`  オリパ ${created} 件を作成しました（既存 ${skipped} 件はスキップ）`)
}
