import { describe, expect, it } from 'vitest'

import { EffectTier, InventoryStatus } from '@/generated/prisma/enums.ts'
import type { CreateOripaInput } from '@/modules/oripa/schema.ts'
import { createOripa, publishOripa } from '@/modules/oripa/service.ts'
import { generateSlots } from '@/modules/oripa/slots.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * オリパ作成まわりの同時実行テスト。
 *
 * ここで守りたいのは「同じ物理在庫が 2 つのオリパの景品になる」状態を
 * 絶対に作らないこと（INV-5）。1 枚しかないカードが 2 人に当たると、
 * どちらかへ必ず発送できなくなる。
 *
 * アプリ層の事前チェックだけでは競合を防げない
 * （2 つのトランザクションが同時に「未割当」を見てしまう）ため、
 * 最終的な保証は oripa_slots.inventory_id のグローバル UNIQUE が行う。
 * このテストはその保証が実際に効いていることを確認する。
 *
 * このプロジェクトは単一ワーカー・直列実行（vitest.config.ts）。
 * テスト内では Promise.allSettled で本当に並行させる。
 */

const DAY = 24 * 60 * 60 * 1000

async function createAdmin(): Promise<string> {
  const admin = await testPrisma.user.create({
    data: {
      email: 'oripa-concurrency@example.test',
      passwordHash: 'dummy-hash',
      role: 'ADMIN',
      profile: { create: { displayName: '管理者' } },
      pointAccount: { create: {} },
    },
    select: { id: true },
  })
  return admin.id
}

async function createInventory(code: string): Promise<string> {
  const inventory = await testPrisma.inventory.create({
    data: {
      code,
      cardTitle: 'ルミナ・クロニクル',
      cardName: '架空カード',
      exchangePoints: 5_000,
    },
    select: { id: true },
  })
  return inventory.id
}

async function createGenericPrize(): Promise<void> {
  await testPrisma.genericPrize.create({
    data: { code: 'GENERIC-CONC-100', name: 'テスト用汎用景品', exchangePoints: 100 },
  })
}

function draftInput(slug: string): CreateOripaInput {
  const at = Date.now()
  return {
    slug,
    name: `同時実行テスト用 ${slug}`,
    pricePoints: 500,
    totalSlots: 5,
    salesStartAt: new Date(at - DAY).toISOString(),
    salesEndAt: new Date(at + 10 * DAY).toISOString(),
    effectSetKey: 'default',
    tiers: [
      { code: 'S', name: 'S賞', effectTier: EffectTier.JACKPOT, slotCount: 1, displayOrder: 0 },
      { code: 'B', name: 'B賞', effectTier: EffectTier.NORMAL, slotCount: 4, displayOrder: 1 },
    ],
  } as CreateOripaInput
}

describe('同一在庫の同時割当', () => {
  it('同じ在庫を 2 つのオリパへ同時に割り当てると、片方だけが成功する', async () => {
    const adminId = await createAdmin()
    await createGenericPrize()
    const inventoryId = await createInventory('INV-SHARED-0001')

    // 先に 2 つの下書きを作っておく（競合させたいのはスロット生成だけ）
    const [first, second] = await testPrisma.$transaction(async (tx) => [
      await createOripa(tx, draftInput('conc-oripa-a'), { id: adminId }),
      await createOripa(tx, draftInput('conc-oripa-b'), { id: adminId }),
    ])

    const allocate = (campaignId: string) =>
      testPrisma.$transaction((tx) =>
        generateSlots(tx, campaignId, {
          allocations: [
            {
              tierCode: 'S',
              inventoryIds: [inventoryId],
              genericPrizeCode: 'GENERIC-CONC-100',
            },
            { tierCode: 'B', inventoryIds: [], genericPrizeCode: 'GENERIC-CONC-100' },
          ],
        }),
      )

    const results = await Promise.allSettled([allocate(first.id), allocate(second.id)])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')

    expect(fulfilled).toHaveLength(1)

    // この在庫を参照しているスロットは、DB 全体で必ず 1 件
    const slotCount = await testPrisma.oripaSlot.count({ where: { inventoryId } })
    expect(slotCount).toBe(1)

    const inventory = await testPrisma.inventory.findUniqueOrThrow({
      where: { id: inventoryId },
      select: { status: true },
    })
    expect(inventory.status).toBe(InventoryStatus.ALLOCATED)
  })

  it('同じ下書きへ同時にスロット生成しても、口数は総口数のまま保たれる', async () => {
    const adminId = await createAdmin()
    await createGenericPrize()
    const inventoryA = await createInventory('INV-A-0001')
    const inventoryB = await createInventory('INV-B-0001')

    const campaign = await testPrisma.$transaction((tx) =>
      createOripa(tx, draftInput('conc-oripa-same'), { id: adminId }),
    )

    const allocate = (inventoryId: string) =>
      testPrisma.$transaction((tx) =>
        generateSlots(tx, campaign.id, {
          allocations: [
            {
              tierCode: 'S',
              inventoryIds: [inventoryId],
              genericPrizeCode: 'GENERIC-CONC-100',
            },
            { tierCode: 'B', inventoryIds: [], genericPrizeCode: 'GENERIC-CONC-100' },
          ],
        }),
      )

    await Promise.allSettled([allocate(inventoryA), allocate(inventoryB)])

    const slots = await testPrisma.oripaSlot.findMany({
      where: { campaignId: campaign.id },
      select: { drawOrder: true },
    })

    // 二重に作られていない（5 口のまま）
    expect(slots).toHaveLength(5)
    // 抽選順も 1..5 の順列のまま
    expect(new Set(slots.map((slot) => slot.drawOrder))).toEqual(new Set([1, 2, 3, 4, 5]))
  })
})

describe('同時公開', () => {
  it('同じオリパを同時に公開しても、コミットハッシュは 1 つだけ確定する', async () => {
    const adminId = await createAdmin()
    await createGenericPrize()
    const inventoryId = await createInventory('INV-PUB-0001')

    const campaign = await testPrisma.$transaction(async (tx) => {
      const created = await createOripa(tx, draftInput('conc-oripa-publish'), { id: adminId })
      await generateSlots(tx, created.id, {
        allocations: [
          { tierCode: 'S', inventoryIds: [inventoryId], genericPrizeCode: 'GENERIC-CONC-100' },
          { tierCode: 'B', inventoryIds: [], genericPrizeCode: 'GENERIC-CONC-100' },
        ],
      })
      return created
    })

    const publish = () =>
      testPrisma.$transaction((tx) => publishOripa(tx, campaign.id, { id: adminId }))

    const results = await Promise.allSettled([publish(), publish()])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')

    // 片方は「公開できるのは下書きのときだけ」で弾かれる。
    // 仮に両方が通っても、DB トリガがコミットハッシュの上書きを拒否する。
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    const stored = await testPrisma.oripaCampaign.findUniqueOrThrow({
      where: { id: campaign.id },
      select: { slotOrderCommit: true, publishedAt: true, status: true },
    })
    expect(stored.slotOrderCommit).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.publishedAt).not.toBeNull()
    expect(stored.status).toBe('ACTIVE')

    const auditLogs = await testPrisma.auditLog.count({
      where: { targetId: campaign.id, action: 'ORIPA_PUBLISH' },
    })
    expect(auditLogs).toBe(1)
  })
})
