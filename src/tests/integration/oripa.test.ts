import { beforeEach, describe, expect, it } from 'vitest'

import { CampaignStatus, EffectTier, InventoryStatus } from '@/generated/prisma/enums.ts'
import { AppError, ERROR_CODES } from '@/lib/api/errors.ts'
import { buildSlotOrderCommitment } from '@/lib/crypto/random.ts'
import { getPublicOripaDetail, listPublicOripas } from '@/modules/oripa/queries.ts'
import type { CreateOripaInput } from '@/modules/oripa/schema.ts'
import {
  checkPublishable,
  createOripa,
  getOripaDetailForAdmin,
  publishOripa,
  resumeOripa,
  suspendOripa,
} from '@/modules/oripa/service.ts'
import { generateSlots, verifySlotOrderCommitment } from '@/modules/oripa/slots.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * オリパのスロット生成と公開の統合テスト。
 *
 * 確認する不変条件:
 *  - draw_order は 1..totalSlots の**順列**である（重複も欠番も無い）
 *  - 割当口数が総口数と一致しない構成は公開できない
 *  - 同じ物理在庫を 2 つのオリパへ割り当てられない
 *  - 公開後は価格・口数・景品構成を変更できない（アプリ層 / DB トリガ）
 *  - シードと draw_order は公開用の応答に一切含まれない
 */

const DAY = 24 * 60 * 60 * 1000

async function createAdmin(email = 'oripa-admin@example.test'): Promise<string> {
  const admin = await testPrisma.user.create({
    data: {
      email,
      passwordHash: 'dummy-hash',
      role: 'ADMIN',
      profile: { create: { displayName: '管理者' } },
      pointAccount: { create: {} },
    },
    select: { id: true },
  })
  return admin.id
}

async function createInventories(count: number, prefix = 'INV'): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const inventory = await testPrisma.inventory.create({
      data: {
        code: `${prefix}-${String(i + 1).padStart(4, '0')}`,
        cardTitle: 'ルミナ・クロニクル',
        cardName: `架空カード${i + 1}`,
        rarity: 'SR',
        exchangePoints: 1_000 + i,
        referencePriceYen: 1_500 + i,
      },
      select: { id: true },
    })
    ids.push(inventory.id)
  }
  return ids
}

async function createGenericPrize(code = 'GENERIC-TEST-100'): Promise<string> {
  const prize = await testPrisma.genericPrize.create({
    data: { code, name: 'テスト用汎用景品', exchangePoints: 100 },
    select: { id: true },
  })
  return prize.id
}

function draftInput(overrides: Partial<CreateOripaInput> = {}): CreateOripaInput {
  const at = Date.now()
  return {
    slug: 'test-oripa',
    name: 'テストオリパ',
    pricePoints: 500,
    totalSlots: 10,
    salesStartAt: new Date(at - DAY).toISOString(),
    salesEndAt: new Date(at + 10 * DAY).toISOString(),
    effectSetKey: 'default',
    tiers: [
      {
        code: 'S',
        name: 'S賞',
        effectTier: EffectTier.JACKPOT,
        slotCount: 2,
        displayOrder: 0,
      },
      {
        code: 'B',
        name: 'B賞',
        effectTier: EffectTier.NORMAL,
        slotCount: 8,
        displayOrder: 1,
      },
    ],
    ...overrides,
  } as CreateOripaInput
}

/** 下書き作成 → 景品割当までを行うヘルパー */
async function createAllocatedDraft(options: {
  adminId: string
  input?: Partial<CreateOripaInput>
  inventoryIds: string[]
  genericPrizeCode: string
}): Promise<string> {
  return testPrisma.$transaction(async (tx) => {
    const created = await createOripa(tx, draftInput(options.input), { id: options.adminId })
    await generateSlots(tx, created.id, {
      allocations: [
        {
          tierCode: 'S',
          inventoryIds: options.inventoryIds,
          genericPrizeCode: options.genericPrizeCode,
        },
        { tierCode: 'B', inventoryIds: [], genericPrizeCode: options.genericPrizeCode },
      ],
    })
    return created.id
  })
}

let adminId: string
let genericCode: string

beforeEach(async () => {
  adminId = await createAdmin()
  await createGenericPrize()
  genericCode = 'GENERIC-TEST-100'
})

describe('スロット生成', () => {
  it('draw_order が 1..totalSlots の順列になる', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })

    const slots = await testPrisma.oripaSlot.findMany({
      where: { campaignId },
      select: { slotNumber: true, drawOrder: true },
    })

    expect(slots).toHaveLength(10)

    const orders = slots.map((slot) => slot.drawOrder).sort((a, b) => a - b)
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    const numbers = slots.map((slot) => slot.slotNumber).sort((a, b) => a - b)
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('ランクごとの口数どおりにスロットを作る', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })

    const grouped = await testPrisma.oripaSlot.groupBy({
      by: ['tierId'],
      where: { campaignId },
      _count: { _all: true },
    })
    const counts = grouped.map((row) => row._count._all).sort((a, b) => a - b)
    expect(counts).toEqual([2, 8])
  })

  it('割り当てた在庫を ALLOCATED にする', async () => {
    const inventoryIds = await createInventories(2)
    await createAllocatedDraft({ adminId, inventoryIds, genericPrizeCode: genericCode })

    const inventories = await testPrisma.inventory.findMany({
      where: { id: { in: inventoryIds } },
      select: { status: true },
    })
    expect(inventories.every((inv) => inv.status === InventoryStatus.ALLOCATED)).toBe(true)
  })

  it('不足分を汎用景品で埋め、交換ポイントをスロットへ複写する', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })

    const generic = await testPrisma.oripaSlot.count({
      where: { campaignId, genericPrizeId: { not: null } },
    })
    expect(generic).toBe(8)

    const genericSlot = await testPrisma.oripaSlot.findFirst({
      where: { campaignId, genericPrizeId: { not: null } },
      select: { exchangePoints: true, inventoryId: true },
    })
    expect(genericSlot?.exchangePoints).toBe(100)
    expect(genericSlot?.inventoryId).toBeNull()
  })

  it('スロットを作り直すと、前回の在庫割当が解除される', async () => {
    const inventoryIds = await createInventories(4)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds: inventoryIds.slice(0, 2),
      genericPrizeCode: genericCode,
    })

    await testPrisma.$transaction((tx) =>
      generateSlots(tx, campaignId, {
        allocations: [
          {
            tierCode: 'S',
            inventoryIds: inventoryIds.slice(2, 4),
            genericPrizeCode: genericCode,
          },
          { tierCode: 'B', inventoryIds: [], genericPrizeCode: genericCode },
        ],
      }),
    )

    const released = await testPrisma.inventory.findMany({
      where: { id: { in: inventoryIds.slice(0, 2) } },
      select: { status: true },
    })
    expect(released.every((inv) => inv.status === InventoryStatus.AVAILABLE)).toBe(true)

    // 作り直したあとも順列は壊れない
    const orders = await testPrisma.oripaSlot.findMany({
      where: { campaignId },
      select: { drawOrder: true },
    })
    expect(new Set(orders.map((o) => o.drawOrder)).size).toBe(10)
  })

  it('不足分の汎用景品を指定しないと拒否する（ハズレ枠を作らせない）', async () => {
    const inventoryIds = await createInventories(2)

    await expect(
      testPrisma.$transaction(async (tx) => {
        const created = await createOripa(tx, draftInput(), { id: adminId })
        await generateSlots(tx, created.id, {
          allocations: [
            { tierCode: 'S', inventoryIds, genericPrizeCode: null },
            { tierCode: 'B', inventoryIds: [], genericPrizeCode: null },
          ],
        })
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR })
  })

  it('ランクの口数より多い在庫を指定すると拒否する', async () => {
    const inventoryIds = await createInventories(3)

    await expect(
      testPrisma.$transaction(async (tx) => {
        const created = await createOripa(tx, draftInput(), { id: adminId })
        await generateSlots(tx, created.id, {
          allocations: [
            { tierCode: 'S', inventoryIds, genericPrizeCode: genericCode },
            { tierCode: 'B', inventoryIds: [], genericPrizeCode: genericCode },
          ],
        })
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR })
  })

  it('同じ在庫を 2 つのランクへ指定すると拒否する', async () => {
    const [inventoryId] = await createInventories(1)
    if (!inventoryId) throw new Error('在庫の作成に失敗しました')

    await expect(
      testPrisma.$transaction(async (tx) => {
        const created = await createOripa(tx, draftInput(), { id: adminId })
        await generateSlots(tx, created.id, {
          allocations: [
            {
              tierCode: 'S',
              inventoryIds: [inventoryId, inventoryId],
              genericPrizeCode: genericCode,
            },
            { tierCode: 'B', inventoryIds: [], genericPrizeCode: genericCode },
          ],
        })
      }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('他のオリパへ割当済みの在庫は指定できない（INV-5）', async () => {
    const inventoryIds = await createInventories(2)
    await createAllocatedDraft({ adminId, inventoryIds, genericPrizeCode: genericCode })

    await expect(
      testPrisma.$transaction(async (tx) => {
        const created = await createOripa(tx, draftInput({ slug: 'test-oripa-2' }), {
          id: adminId,
        })
        await generateSlots(tx, created.id, {
          allocations: [
            { tierCode: 'S', inventoryIds, genericPrizeCode: genericCode },
            { tierCode: 'B', inventoryIds: [], genericPrizeCode: genericCode },
          ],
        })
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('公開条件', () => {
  it('スロット未生成なら公開できない', async () => {
    const campaignId = await testPrisma.$transaction(async (tx) => {
      const created = await createOripa(tx, draftInput(), { id: adminId })
      return created.id
    })

    const check = await checkPublishable(testPrisma, campaignId)
    expect(check.publishable).toBe(false)
    expect(check.problems.some((problem) => problem.field === 'slots')).toBe(true)
  })

  it('販売終了日時が過ぎていると公開できない', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
      input: {
        salesStartAt: new Date(Date.now() - 10 * DAY).toISOString(),
        salesEndAt: new Date(Date.now() - DAY).toISOString(),
      },
    })

    const check = await checkPublishable(testPrisma, campaignId)
    expect(check.publishable).toBe(false)
    expect(check.problems.some((problem) => problem.field === 'salesEndAt')).toBe(true)
  })

  it('条件を満たしていれば公開できる。期待値は整数比のまま返る', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })

    const check = await checkPublishable(testPrisma, campaignId)
    expect(check.publishable).toBe(true)
    expect(check.summary.generatedSlots).toBe(10)
    expect(check.summary.expectedValueDenominator).toBe(10)
    // S 賞 2 枚（1,000 + 1,001）+ 汎用 8 枚（100 × 8）
    expect(check.summary.expectedValueNumerator).toBe(1_000 + 1_001 + 800)
  })
})

describe('公開', () => {
  async function publishDraft(campaignId: string) {
    return testPrisma.$transaction((tx) => publishOripa(tx, campaignId, { id: adminId }))
  }

  it('販売開始が過去なら ACTIVE、未来なら SCHEDULED になる', async () => {
    const inventoryIds = await createInventories(2)
    const activeId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })
    expect((await publishDraft(activeId)).status).toBe(CampaignStatus.ACTIVE)

    const futureInventories = await createInventories(2, 'FUT')
    const scheduledId = await createAllocatedDraft({
      adminId,
      inventoryIds: futureInventories,
      genericPrizeCode: genericCode,
      input: {
        slug: 'test-oripa-future',
        salesStartAt: new Date(Date.now() + DAY).toISOString(),
        salesEndAt: new Date(Date.now() + 10 * DAY).toISOString(),
      },
    })
    expect((await publishDraft(scheduledId)).status).toBe(CampaignStatus.SCHEDULED)
  })

  it('コミットハッシュが保存され、保存済みスロット順から再計算した値と一致する', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })
    const published = await publishDraft(campaignId)

    expect(published.slotOrderCommit).toMatch(/^[0-9a-f]{64}$/)

    const verification = await verifySlotOrderCommitment(testPrisma, campaignId)
    expect(verification.matches).toBe(true)
    expect(verification.storedCommit).toBe(published.slotOrderCommit)
  })

  it('第三者が公開されたシードだけで検証できる', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })
    const published = await publishDraft(campaignId)

    // 販売終了後にシードを公開した、という状態にする
    const campaign = await testPrisma.oripaCampaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { slotOrderSeed: true },
    })

    const slots = await testPrisma.oripaSlot.findMany({
      where: { campaignId },
      select: { tier: { select: { code: true } } },
      orderBy: { drawOrder: 'asc' },
    })

    const recomputed = buildSlotOrderCommitment({
      campaignId,
      serverSeed: campaign.slotOrderSeed ?? '',
      tierCodesInDrawOrder: slots.map((slot) => slot.tier.code),
    })

    expect(recomputed).toBe(published.slotOrderCommit)
  })

  it('公開すると 2 回目の公開は拒否される', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })
    await publishDraft(campaignId)

    await expect(publishDraft(campaignId)).rejects.toMatchObject({
      code: ERROR_CODES.CAMPAIGN_NOT_PUBLISHABLE,
    })
  })

  it('監査ログへシードを残さない', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })
    await publishDraft(campaignId)

    const campaign = await testPrisma.oripaCampaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { slotOrderSeed: true },
    })
    const logs = await testPrisma.auditLog.findMany({
      where: { targetId: campaignId, action: 'ORIPA_PUBLISH' },
      select: { after: true },
    })

    expect(logs).toHaveLength(1)
    expect(JSON.stringify(logs[0]?.after)).not.toContain(campaign.slotOrderSeed)
  })
})

describe('公開後の不変性', () => {
  async function publishedCampaign(): Promise<string> {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })
    await testPrisma.$transaction((tx) => publishOripa(tx, campaignId, { id: adminId }))
    return campaignId
  }

  it('アプリ層がスロットの作り直しを拒否する', async () => {
    const campaignId = await publishedCampaign()

    await expect(
      testPrisma.$transaction((tx) =>
        generateSlots(tx, campaignId, {
          allocations: [
            { tierCode: 'S', inventoryIds: [], genericPrizeCode: genericCode },
            { tierCode: 'B', inventoryIds: [], genericPrizeCode: genericCode },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.CAMPAIGN_IMMUTABLE })
  })

  it('DB トリガが価格の変更を拒否する（アプリ層を迂回しても防ぐ）', async () => {
    const campaignId = await publishedCampaign()

    await expect(
      testPrisma.oripaCampaign.update({
        where: { id: campaignId },
        data: { pricePoints: 1 },
      }),
    ).rejects.toThrow(/CAMPAIGN_IMMUTABLE/)
  })

  it('DB トリガが総口数の変更を拒否する', async () => {
    const campaignId = await publishedCampaign()

    await expect(
      testPrisma.oripaCampaign.update({
        where: { id: campaignId },
        data: { totalSlots: 5 },
      }),
    ).rejects.toThrow(/CAMPAIGN_IMMUTABLE/)
  })

  it('DB トリガがコミットハッシュとシードの書き換えを拒否する', async () => {
    const campaignId = await publishedCampaign()

    await expect(
      testPrisma.oripaCampaign.update({
        where: { id: campaignId },
        data: { slotOrderCommit: '0'.repeat(64) },
      }),
    ).rejects.toThrow(/CAMPAIGN_IMMUTABLE/)

    await expect(
      testPrisma.oripaCampaign.update({
        where: { id: campaignId },
        data: { slotOrderSeed: 'tampered' },
      }),
    ).rejects.toThrow(/CAMPAIGN_IMMUTABLE/)
  })

  it('DB トリガがスロットの景品差し替えと抽選順の変更を拒否する', async () => {
    const campaignId = await publishedCampaign()
    const slot = await testPrisma.oripaSlot.findFirstOrThrow({
      where: { campaignId },
      select: { id: true, drawOrder: true },
    })

    await expect(
      testPrisma.oripaSlot.update({
        where: { id: slot.id },
        data: { exchangePoints: 999_999 },
      }),
    ).rejects.toThrow(/CAMPAIGN_IMMUTABLE/)

    await expect(testPrisma.oripaSlot.delete({ where: { id: slot.id } })).rejects.toThrow(
      /CAMPAIGN_IMMUTABLE/,
    )
  })

  it('DB トリガがランクの口数変更を拒否する（確率の後出し変更を防ぐ）', async () => {
    const campaignId = await publishedCampaign()
    const tier = await testPrisma.oripaPrizeTier.findFirstOrThrow({
      where: { campaignId },
      select: { id: true },
    })

    await expect(
      testPrisma.oripaPrizeTier.update({ where: { id: tier.id }, data: { slotCount: 99 } }),
    ).rejects.toThrow(/CAMPAIGN_IMMUTABLE/)
  })

  it('抽選による AVAILABLE → DRAWN の遷移は許可される', async () => {
    const campaignId = await publishedCampaign()
    const slot = await testPrisma.oripaSlot.findFirstOrThrow({
      where: { campaignId },
      select: { id: true },
    })

    const winner = await testPrisma.user.create({
      data: {
        email: 'winner@example.test',
        passwordHash: 'dummy-hash',
        profile: { create: { displayName: '当選者' } },
        pointAccount: { create: {} },
      },
      select: { id: true },
    })

    const updated = await testPrisma.oripaSlot.update({
      where: { id: slot.id },
      data: { status: 'DRAWN', drawnByUserId: winner.id, drawnAt: new Date() },
      select: { status: true },
    })
    expect(updated.status).toBe('DRAWN')
  })
})

describe('販売停止と再開', () => {
  it('停止すると理由が記録され、再開で元の状態へ戻る', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })
    await testPrisma.$transaction((tx) => publishOripa(tx, campaignId, { id: adminId }))

    const suspended = await testPrisma.$transaction((tx) =>
      suspendOripa(tx, campaignId, '在庫確認のため一時停止', { id: adminId }),
    )
    expect(suspended.status).toBe(CampaignStatus.SUSPENDED)

    const record = await testPrisma.oripaCampaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { suspendReason: true, suspendedAt: true },
    })
    expect(record.suspendReason).toBe('在庫確認のため一時停止')
    expect(record.suspendedAt).not.toBeNull()

    const resumed = await testPrisma.$transaction((tx) =>
      resumeOripa(tx, campaignId, '確認が完了したため再開', { id: adminId }),
    )
    expect(resumed.status).toBe(CampaignStatus.ACTIVE)
  })

  it('下書きは停止できない', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })

    await expect(
      testPrisma.$transaction((tx) =>
        suspendOripa(tx, campaignId, '理由テキスト', { id: adminId }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT })
  })
})

describe('ユーザー向けの参照', () => {
  it('下書きは一覧に出ない。公開後に出る', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })

    expect(await listPublicOripas()).toHaveLength(0)

    await testPrisma.$transaction((tx) => publishOripa(tx, campaignId, { id: adminId }))
    const listed = await listPublicOripas()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.saleState).toBe('ON_SALE')
  })

  it('詳細にシードを含めない（未公開のあいだは null）', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })
    await testPrisma.$transaction((tx) => publishOripa(tx, campaignId, { id: adminId }))

    const detail = await getPublicOripaDetail('test-oripa')
    expect(detail.revealedSeed).toBeNull()
    expect(detail.slotOrderCommit).toMatch(/^[0-9a-f]{64}$/)

    // 応答のどこにも draw_order とシードが入っていないこと
    const campaign = await testPrisma.oripaCampaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { slotOrderSeed: true },
    })
    const serialized = JSON.stringify(detail)
    expect(serialized).not.toContain(campaign.slotOrderSeed)
    expect(serialized).not.toContain('drawOrder')
  })

  it('シードを公開したあとだけ revealedSeed を返す', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })
    await testPrisma.$transaction((tx) => publishOripa(tx, campaignId, { id: adminId }))

    await testPrisma.oripaCampaign.update({
      where: { id: campaignId },
      data: { slotOrderRevealedAt: new Date() },
    })

    const stored = await testPrisma.oripaCampaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { slotOrderSeed: true },
    })

    const detail = await getPublicOripaDetail('test-oripa')
    // シードは base64url（secureToken）。公開後は保存値がそのまま返る。
    expect(detail.revealedSeed).toBe(stored.slotOrderSeed)
    expect(detail.revealedSeed).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('確率は整数比のまま保持され、表示用の文字列が付く', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })
    await testPrisma.$transaction((tx) => publishOripa(tx, campaignId, { id: adminId }))

    const detail = await getPublicOripaDetail('test-oripa')
    const sTier = detail.tiers.find((tier) => tier.code === 'S')

    expect(sTier?.odds).toEqual({ numerator: 2, denominator: 10 })
    expect(sTier?.remainingCount).toBe(2)
    expect(sTier?.oddsPercent).toBe('20.000%')
  })

  it('管理画面の詳細にもシードと抽選順を含めない', async () => {
    const inventoryIds = await createInventories(2)
    const campaignId = await createAllocatedDraft({
      adminId,
      inventoryIds,
      genericPrizeCode: genericCode,
    })
    await testPrisma.$transaction((tx) => publishOripa(tx, campaignId, { id: adminId }))

    const detail = await getOripaDetailForAdmin(campaignId)
    const campaign = await testPrisma.oripaCampaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { slotOrderSeed: true },
    })

    const serialized = JSON.stringify(detail)
    expect(serialized).not.toContain(campaign.slotOrderSeed)
    expect(serialized).not.toContain('drawOrder')
    expect(detail.slotOrderCommit).toMatch(/^[0-9a-f]{64}$/)
  })
})
