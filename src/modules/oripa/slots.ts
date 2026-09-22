import { errors } from '@/lib/api/errors.ts'
import {
  buildSlotOrderCommitment,
  secureShuffledSequence,
  secureToken,
} from '@/lib/crypto/random.ts'
import { markAllocated, releaseAllocation } from '@/modules/inventory/service.ts'
import type { PrismaTransactionClient } from '@/server/db.ts'

import type { AllocateSlotsInput } from './schema.ts'

/**
 * 抽選スロットの生成（有限プール方式の中核）。
 *
 * ■ 事前シャッフル
 *   公開前に全スロットを作り、CSPRNG による Fisher-Yates で
 *   1..totalSlots の順列を `draw_order` に割り当てる。
 *   抽選は「AVAILABLE を draw_order 昇順で n 件取る」だけになる。
 *
 *   - 非復元抽出として分布が厳密に正しい
 *   - 部分インデックスの先頭だけを見るので O(log n) で競合に強い
 *   - 公開時にコミットハッシュを記録すれば、後からの差し替えを検証できる
 *
 *   詳細と代替案の比較は docs/06-draw-algorithm.md を参照。
 *
 * ■ draw_order は絶対に外へ出さない
 *   この値が分かると「次に何が出るか」が分かってしまう。
 *   API・管理画面のどの応答にも含めないこと。
 */

export interface GenerateSlotsResult {
  totalSlots: number
  /** ランクごとの生成数 */
  perTier: { tierCode: string; count: number }[]
}

interface PlannedSlot {
  tierId: string
  tierCode: string
  inventoryId: string | null
  genericPrizeId: string | null
  exchangePoints: number
}

/**
 * 景品を割り当ててスロットを作り直す。
 *
 * DRAFT のキャンペーンでのみ実行できる。
 * 既存のスロットはいったん削除し、在庫の割当も解除してから作り直す
 * （部分的な更新にすると、途中で失敗したときに整合性が崩れるため）。
 */
export async function generateSlots(
  tx: PrismaTransactionClient,
  campaignId: string,
  input: AllocateSlotsInput,
): Promise<GenerateSlotsResult> {
  const campaign = await tx.oripaCampaign.findFirst({
    where: { id: campaignId, deletedAt: null },
    select: {
      id: true,
      status: true,
      publishedAt: true,
      totalSlots: true,
      tiers: {
        select: { id: true, code: true, slotCount: true },
        orderBy: { displayOrder: 'asc' },
      },
    },
  })

  if (!campaign) {
    throw errors.notFound('オリパ')
  }
  if (campaign.publishedAt !== null || campaign.status !== 'DRAFT') {
    throw errors.campaignImmutable('slots')
  }

  // --- 既存スロットを片付ける ---
  const existingSlots = await tx.oripaSlot.findMany({
    where: { campaignId },
    select: { inventoryId: true },
  })
  const previousInventoryIds = existingSlots
    .map((slot) => slot.inventoryId)
    .filter((id): id is string => id !== null)

  await tx.oripaSlot.deleteMany({ where: { campaignId } })
  await releaseAllocation(tx, previousInventoryIds)

  // --- 割当の計画を立てる ---
  const tiersByCode = new Map(campaign.tiers.map((tier) => [tier.code, tier]))
  const planned: PlannedSlot[] = []
  const usedInventoryIds = new Set<string>()

  for (const allocation of input.allocations) {
    const tier = tiersByCode.get(allocation.tierCode)
    if (!tier) {
      throw errors.validation([
        {
          field: 'allocations',
          message: `ランク「${allocation.tierCode}」は存在しません`,
        },
      ])
    }

    const inventoryIds = allocation.inventoryIds
    if (inventoryIds.length > tier.slotCount) {
      throw errors.validation([
        {
          field: 'allocations',
          message:
            `ランク「${tier.code}」に指定した在庫が多すぎます` +
            `（口数 ${tier.slotCount} に対し ${inventoryIds.length} 件）`,
        },
      ])
    }

    // 同じ在庫を 2 回指定していないか（DB の UNIQUE でも弾かれるが、
    // 分かりやすいエラーにするため先に検査する）
    for (const inventoryId of inventoryIds) {
      if (usedInventoryIds.has(inventoryId)) {
        throw errors.inventoryAlreadyAllocated(inventoryId)
      }
      usedInventoryIds.add(inventoryId)
    }

    const inventories = await tx.inventory.findMany({
      where: { id: { in: [...inventoryIds] }, deletedAt: null },
      select: { id: true, exchangePoints: true, status: true },
    })

    if (inventories.length !== inventoryIds.length) {
      throw errors.validation([
        { field: 'allocations', message: '存在しない在庫が指定されています' },
      ])
    }

    const unavailable = inventories.filter((inv) => inv.status !== 'AVAILABLE')
    if (unavailable.length > 0) {
      throw errors.inventoryAlreadyAllocated(unavailable[0]?.id ?? '')
    }

    const exchangePointsById = new Map(inventories.map((inv) => [inv.id, inv.exchangePoints]))

    for (const inventoryId of inventoryIds) {
      planned.push({
        tierId: tier.id,
        tierCode: tier.code,
        inventoryId,
        genericPrizeId: null,
        exchangePoints: exchangePointsById.get(inventoryId) ?? 0,
      })
    }

    // --- 不足分を汎用景品で埋める ---
    const shortage = tier.slotCount - inventoryIds.length
    if (shortage > 0) {
      if (!allocation.genericPrizeCode) {
        throw errors.validation([
          {
            field: 'allocations',
            message:
              `ランク「${tier.code}」に ${shortage} 件の不足があります。` +
              '在庫を追加するか、代替となる汎用景品を指定してください',
          },
        ])
      }

      const generic = await tx.genericPrize.findFirst({
        where: { code: allocation.genericPrizeCode, isActive: true },
        select: { id: true, exchangePoints: true },
      })

      if (!generic) {
        throw errors.validation([
          {
            field: 'allocations',
            message: `汎用景品「${allocation.genericPrizeCode}」が見つかりません`,
          },
        ])
      }

      for (let i = 0; i < shortage; i++) {
        planned.push({
          tierId: tier.id,
          tierCode: tier.code,
          inventoryId: null,
          genericPrizeId: generic.id,
          exchangePoints: generic.exchangePoints,
        })
      }
    }
  }

  // --- 総口数との一致を確認する（公開条件の中核） ---
  if (planned.length !== campaign.totalSlots) {
    throw errors.validation([
      {
        field: 'allocations',
        message: `割り当てた口数（${planned.length}）が総口数（${campaign.totalSlots}）と一致しません`,
      },
    ])
  }

  // --- 抽選順をシャッフルする ---
  // planned は「ランクごとにまとまった並び」なので、そのままでは順序に偏りがある。
  // draw_order へ順列を割り当てることで、先頭から取るだけで一様な抽選になる。
  const drawOrders = secureShuffledSequence(planned.length)

  const slotsToCreate = planned.map((slot, index) => ({
    campaignId,
    slotNumber: index + 1,
    drawOrder: drawOrders[index] ?? index + 1,
    inventoryId: slot.inventoryId,
    genericPrizeId: slot.genericPrizeId,
    tierId: slot.tierId,
    exchangePoints: slot.exchangePoints,
  }))

  await tx.oripaSlot.createMany({ data: slotsToCreate })
  await markAllocated(tx, [...usedInventoryIds])

  const perTier = campaign.tiers.map((tier) => ({
    tierCode: tier.code,
    count: planned.filter((slot) => slot.tierId === tier.id).length,
  }))

  // コミットハッシュは公開時に、実際に保存されたスロット順から計算する
  // （buildCommitment）。ここで作ると、下書きを作り直すたびに
  // 「公開していないのにコミットした」状態が生まれてしまう。
  return { totalSlots: planned.length, perTier }
}

export interface Commitment {
  slotOrderCommit: string
  serverSeed: string
}

/**
 * 公開時のコミットハッシュを作る。
 *
 * **DB に保存済みのスロット順**から計算する。
 * メモリ上の計画値ではなく実データを使うことで、
 * 「保存に失敗した分がハッシュに含まれる」ようなズレを防ぐ。
 */
export async function buildCommitment(
  tx: PrismaTransactionClient,
  campaignId: string,
): Promise<Commitment> {
  const slots = await tx.oripaSlot.findMany({
    where: { campaignId },
    select: { tier: { select: { code: true } } },
    orderBy: { drawOrder: 'asc' },
  })

  if (slots.length === 0) {
    throw errors.validation([{ field: 'slots', message: 'スロットが生成されていません' }])
  }

  const serverSeed = secureToken(32)
  const slotOrderCommit = buildSlotOrderCommitment({
    campaignId,
    serverSeed,
    tierCodesInDrawOrder: slots.map((slot) => slot.tier.code),
  })

  return { slotOrderCommit, serverSeed }
}

/**
 * 公開時に保存されたコミットハッシュを検証する。
 *
 * 販売終了後にシードを公開したあと、第三者がこれと同じ計算で
 * 「景品構成が差し替えられていないこと」を確認できる。
 * 管理者向けの自己点検にも使う。
 */
export async function verifySlotOrderCommitment(
  tx: PrismaTransactionClient,
  campaignId: string,
): Promise<{ matches: boolean; storedCommit: string | null }> {
  const campaign = await tx.oripaCampaign.findUnique({
    where: { id: campaignId },
    select: { id: true, slotOrderCommit: true, slotOrderSeed: true },
  })

  if (!campaign?.slotOrderCommit || !campaign.slotOrderSeed) {
    return { matches: false, storedCommit: campaign?.slotOrderCommit ?? null }
  }

  const slots = await tx.oripaSlot.findMany({
    where: { campaignId },
    select: { drawOrder: true, tier: { select: { code: true } } },
    orderBy: { drawOrder: 'asc' },
  })

  const recomputed = buildSlotOrderCommitment({
    campaignId: campaign.id,
    serverSeed: campaign.slotOrderSeed,
    tierCodesInDrawOrder: slots.map((slot) => slot.tier.code),
  })

  return {
    matches: recomputed === campaign.slotOrderCommit,
    storedCommit: campaign.slotOrderCommit,
  }
}
