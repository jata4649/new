import { describe, expect, it } from 'vitest'

import {
  CampaignStatus,
  EffectTier,
  PointTxType,
  PointType,
  SlotStatus,
} from '@/generated/prisma/enums.ts'
import { ERROR_CODES } from '@/lib/api/errors.ts'
import { addDays, now } from '@/lib/datetime/index.ts'
import { buildRequestHash, runIdempotent } from '@/lib/idempotency/index.ts'
import { executeDraw } from '@/modules/draws/service.ts'
import { createOripa, publishOripa } from '@/modules/oripa/service.ts'
import { generateSlots } from '@/modules/oripa/slots.ts'
import { grantPoints } from '@/modules/points/ledger.ts'
import { getSpendableBalance } from '@/modules/points/repository.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * 抽選の同時実行テスト。
 *
 * 要件で明示されている競合ケースを検証する。
 *  - 残り 1 口へ複数ユーザーが同時に抽選 → 当選は 1 人だけ
 *  - 同じ冪等性キーで同時送信 → 抽選は 1 回だけ
 *  - 残高ちょうどで同時に 2 回抽選 → 成立するのは 1 回だけ
 *  - 購入上限ちょうどで同時に抽選 → 上限を超えない
 *
 * このプロジェクトは単一ワーカー・直列実行（vitest.config.ts）。
 * テスト内では Promise.allSettled で本当に並行させる。
 */

const DAY = 24 * 60 * 60 * 1000

async function createUser(email: string, role: 'USER' | 'ADMIN' = 'USER'): Promise<string> {
  const user = await testPrisma.user.create({
    data: {
      email,
      passwordHash: 'dummy-hash',
      role,
      profile: { create: { displayName: email } },
      pointAccount: { create: {} },
    },
    select: { id: true },
  })
  return user.id
}

async function giveFreePoints(userId: string, amount: number): Promise<void> {
  await testPrisma.$transaction((tx) =>
    grantPoints(tx, {
      userId,
      amount,
      pointType: PointType.FREE,
      txType: PointTxType.BONUS,
      sourceType: 'TEST',
      sourceId: `conc-${userId}-${amount}`,
      expiresAt: addDays(now(), 30),
    }),
  )
}

/**
 * 全スロットが汎用景品のオリパを作る。
 * 物理在庫を使わないので、口数を自由に決められる。
 */
async function createCampaign(options: {
  slug: string
  totalSlots: number
  pricePoints?: number
  perUserLimit?: number | null
  adminId: string
}): Promise<{ id: string; slug: string }> {
  await testPrisma.genericPrize.upsert({
    where: { code: 'GENERIC-CONC-DRAW' },
    update: {},
    create: { code: 'GENERIC-CONC-DRAW', name: '汎用景品', exchangePoints: 100 },
  })

  const at = now()
  return testPrisma.$transaction(async (tx) => {
    const campaign = await createOripa(
      tx,
      {
        slug: options.slug,
        name: `同時実行テスト ${options.slug}`,
        pricePoints: options.pricePoints ?? 100,
        totalSlots: options.totalSlots,
        perUserLimit: options.perUserLimit ?? null,
        salesStartAt: new Date(at.getTime() - DAY).toISOString(),
        salesEndAt: new Date(at.getTime() + 10 * DAY).toISOString(),
        effectSetKey: 'default',
        tiers: [
          {
            code: 'A',
            name: 'A賞',
            effectTier: EffectTier.NORMAL,
            slotCount: options.totalSlots,
            displayOrder: 0,
          },
        ],
      },
      { id: options.adminId },
    )

    await generateSlots(tx, campaign.id, {
      allocations: [{ tierCode: 'A', inventoryIds: [], genericPrizeCode: 'GENERIC-CONC-DRAW' }],
    })
    await publishOripa(tx, campaign.id, { id: options.adminId })
    return campaign
  })
}

/**
 * 本番と同じ経路で抽選する。
 *
 * 冪等性キーの INSERT が業務処理と同じトランザクションの最初に入る
 * （runIdempotent）ことが、この一連のテストの前提になっている。
 */
function drawViaApi(options: { userId: string; slug: string; drawCount: number; key: string }) {
  return runIdempotent(
    {
      userId: options.userId,
      scope: 'draw',
      key: options.key,
      requestHash: buildRequestHash({
        body: { drawCount: options.drawCount },
        params: { slug: options.slug },
        route: `/api/oripas/${options.slug}/draw`,
      }),
    },
    (tx, idempotencyKeyId) =>
      executeDraw(tx, {
        userId: options.userId,
        slug: options.slug,
        drawCount: options.drawCount,
        idempotencyKeyId,
      }),
  )
}

describe('残り 1 口への同時抽選', () => {
  it('5 人が同時に引いても、当選するのは 1 人だけ', async () => {
    const adminId = await createUser('conc-admin@example.test', 'ADMIN')
    const campaign = await createCampaign({ slug: 'conc-last-slot', totalSlots: 1, adminId })

    const userIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = await createUser(`conc-user-${i}@example.test`)
      await giveFreePoints(id, 1_000)
      userIds.push(id)
    }

    const results = await Promise.allSettled(
      userIds.map((userId) =>
        drawViaApi({ userId, slug: campaign.slug, drawCount: 1, key: `key-${userId}` }),
      ),
    )

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)

    // 落ちた 4 人はいずれも「残り口数が足りない」
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: ERROR_CODES.INSUFFICIENT_SLOTS })
      }
    }

    // スロットは 1 件だけ DRAWN、当選商品も 1 件だけ
    expect(
      await testPrisma.oripaSlot.count({
        where: { campaignId: campaign.id, status: SlotStatus.DRAWN },
      }),
    ).toBe(1)
    expect(await testPrisma.userPrize.count()).toBe(1)
    expect(await testPrisma.drawTransaction.count()).toBe(1)

    // 外れた 4 人のポイントは 1 ポイントも減っていない
    for (const userId of userIds) {
      const balance = await getSpendableBalance(testPrisma, userId, now())
      const total = balance.paidBalance + balance.freeBalance
      expect(total === 1_000 || total === 900).toBe(true)
    }

    const campaignAfter = await testPrisma.oripaCampaign.findUniqueOrThrow({
      where: { id: campaign.id },
      select: { remainingSlots: true, status: true },
    })
    expect(campaignAfter.remainingSlots).toBe(0)
    expect(campaignAfter.status).toBe(CampaignStatus.SOLD_OUT)
  })

  it('残り 10 口へ 10 人が 1 口ずつ同時に引くと、全員が別のスロットに当たる', async () => {
    const adminId = await createUser('conc-admin2@example.test', 'ADMIN')
    const campaign = await createCampaign({ slug: 'conc-ten', totalSlots: 10, adminId })

    const userIds: string[] = []
    for (let i = 0; i < 10; i++) {
      const id = await createUser(`conc-ten-${i}@example.test`)
      await giveFreePoints(id, 1_000)
      userIds.push(id)
    }

    const results = await Promise.allSettled(
      userIds.map((userId) =>
        drawViaApi({ userId, slug: campaign.slug, drawCount: 1, key: `ten-${userId}` }),
      ),
    )

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10)

    const drawResults = await testPrisma.drawResult.findMany({ select: { slotId: true } })
    expect(drawResults).toHaveLength(10)
    // 同じスロットが 2 人に当たっていない
    expect(new Set(drawResults.map((row) => row.slotId)).size).toBe(10)

    const campaignAfter = await testPrisma.oripaCampaign.findUniqueOrThrow({
      where: { id: campaign.id },
      select: { remainingSlots: true },
    })
    expect(campaignAfter.remainingSlots).toBe(0)
  })
})

describe('同じ冪等性キーでの同時送信', () => {
  it('抽選は 1 回だけ行われ、2 つ目はリプレイになる', async () => {
    const adminId = await createUser('conc-admin3@example.test', 'ADMIN')
    const campaign = await createCampaign({ slug: 'conc-idem', totalSlots: 10, adminId })
    const userId = await createUser('conc-idem-user@example.test')
    await giveFreePoints(userId, 1_000)

    const key = 'same-key-for-both'
    const results = await Promise.allSettled([
      drawViaApi({ userId, slug: campaign.slug, drawCount: 1, key }),
      drawViaApi({ userId, slug: campaign.slug, drawCount: 1, key }),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    // 両方成功するのが正しい挙動（片方はリプレイ）。
    // 片方が REQUEST_IN_PROGRESS で落ちることもありうるが、
    // いずれにせよ抽選が 2 回行われてはならない。
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    expect(await testPrisma.drawTransaction.count()).toBe(1)
    expect(await testPrisma.userPrize.count()).toBe(1)
    expect(
      await testPrisma.pointLedgerEntry.count({ where: { txType: PointTxType.DRAW } }),
    ).toBe(1)

    const balance = await getSpendableBalance(testPrisma, userId, now())
    expect(balance.paidBalance + balance.freeBalance).toBe(900)

    // 成功した 2 件は同じ抽選 ID を返す
    if (fulfilled.length === 2) {
      const ids = fulfilled.map((result) =>
        result.status === 'fulfilled' ? result.value.data.drawTransactionId : null,
      )
      expect(ids[0]).toBe(ids[1])
      expect(fulfilled.some((r) => r.status === 'fulfilled' && r.value.replayed)).toBe(true)
    }
  })

  it('連続した再送でも抽選は増えない', async () => {
    const adminId = await createUser('conc-admin4@example.test', 'ADMIN')
    const campaign = await createCampaign({ slug: 'conc-retry', totalSlots: 10, adminId })
    const userId = await createUser('conc-retry-user@example.test')
    await giveFreePoints(userId, 1_000)

    const key = 'retry-key'
    const first = await drawViaApi({ userId, slug: campaign.slug, drawCount: 1, key })
    const second = await drawViaApi({ userId, slug: campaign.slug, drawCount: 1, key })
    const third = await drawViaApi({ userId, slug: campaign.slug, drawCount: 1, key })

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(third.replayed).toBe(true)
    expect(second.data.drawTransactionId).toBe(first.data.drawTransactionId)

    expect(await testPrisma.drawTransaction.count()).toBe(1)
    const balance = await getSpendableBalance(testPrisma, userId, now())
    expect(balance.paidBalance + balance.freeBalance).toBe(900)
  })
})

describe('残高ちょうどでの同時抽選', () => {
  it('1 回ぶんの残高で 2 回同時に引くと、成立するのは 1 回だけ', async () => {
    const adminId = await createUser('conc-admin5@example.test', 'ADMIN')
    const campaign = await createCampaign({ slug: 'conc-balance', totalSlots: 10, adminId })
    const userId = await createUser('conc-balance-user@example.test')
    // 1 口ぶんちょうど
    await giveFreePoints(userId, 100)

    const results = await Promise.allSettled([
      drawViaApi({ userId, slug: campaign.slug, drawCount: 1, key: 'balance-a' }),
      drawViaApi({ userId, slug: campaign.slug, drawCount: 1, key: 'balance-b' }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)

    const balance = await getSpendableBalance(testPrisma, userId, now())
    expect(balance.paidBalance + balance.freeBalance).toBe(0)

    expect(await testPrisma.drawTransaction.count()).toBe(1)
    // 失敗した側のスロットは戻っている（消費されていない）
    expect(
      await testPrisma.oripaSlot.count({
        where: { campaignId: campaign.id, status: SlotStatus.DRAWN },
      }),
    ).toBe(1)
  })
})

describe('購入上限ちょうどでの同時抽選', () => {
  it('上限 2 口のオリパへ同時に 3 回引いても、2 口を超えない', async () => {
    const adminId = await createUser('conc-admin6@example.test', 'ADMIN')
    const campaign = await createCampaign({
      slug: 'conc-limit',
      totalSlots: 20,
      perUserLimit: 2,
      adminId,
    })
    const userId = await createUser('conc-limit-user@example.test')
    await giveFreePoints(userId, 10_000)

    const results = await Promise.allSettled([
      drawViaApi({ userId, slug: campaign.slug, drawCount: 1, key: 'limit-a' }),
      drawViaApi({ userId, slug: campaign.slug, drawCount: 1, key: 'limit-b' }),
      drawViaApi({ userId, slug: campaign.slug, drawCount: 1, key: 'limit-c' }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)

    const counter = await testPrisma.userCampaignCounter.findUniqueOrThrow({
      where: { userId_campaignId: { userId, campaignId: campaign.id } },
      select: { drawnCount: true },
    })
    expect(counter.drawnCount).toBe(2)
    expect(await testPrisma.userPrize.count()).toBe(2)
  })
})

describe('多数の同時抽選', () => {
  it('20 人が 10 口のオリパへ殺到しても、当選は 10 口ぶんで止まる', async () => {
    const adminId = await createUser('conc-admin7@example.test', 'ADMIN')
    const campaign = await createCampaign({ slug: 'conc-rush', totalSlots: 10, adminId })

    const userIds: string[] = []
    for (let i = 0; i < 20; i++) {
      const id = await createUser(`conc-rush-${i}@example.test`)
      await giveFreePoints(id, 1_000)
      userIds.push(id)
    }

    const results = await Promise.allSettled(
      userIds.map((userId) =>
        drawViaApi({ userId, slug: campaign.slug, drawCount: 1, key: `rush-${userId}` }),
      ),
    )

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    expect(fulfilled).toHaveLength(10)

    // スロットの総数は変わらず、DRAWN は 10 件
    const slots = await testPrisma.oripaSlot.groupBy({
      by: ['status'],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    })
    const drawn = slots.find((row) => row.status === SlotStatus.DRAWN)?._count._all ?? 0
    expect(drawn).toBe(10)

    // 当選商品 = 抽選記録 = 台帳の DRAW 記帳、すべて 10 件で一致
    expect(await testPrisma.userPrize.count()).toBe(10)
    expect(await testPrisma.drawTransaction.count()).toBe(10)
    expect(
      await testPrisma.pointLedgerEntry.count({ where: { txType: PointTxType.DRAW } }),
    ).toBe(10)

    const campaignAfter = await testPrisma.oripaCampaign.findUniqueOrThrow({
      where: { id: campaign.id },
      select: { remainingSlots: true, status: true },
    })
    expect(campaignAfter.remainingSlots).toBe(0)
    expect(campaignAfter.status).toBe(CampaignStatus.SOLD_OUT)
  })
})
