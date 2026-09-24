import { describe, expect, it } from 'vitest'

import {
  EffectTier,
  InventoryStatus,
  PointTxType,
  PointType,
  PrizeStatus,
} from '@/generated/prisma/enums.ts'
import { ERROR_CODES } from '@/lib/api/errors.ts'
import { addDays, now } from '@/lib/datetime/index.ts'
import { buildRequestHash, runIdempotent } from '@/lib/idempotency/index.ts'
import { executeDraw } from '@/modules/draws/service.ts'
import { createOripa, publishOripa } from '@/modules/oripa/service.ts'
import { generateSlots } from '@/modules/oripa/slots.ts'
import { grantPoints } from '@/modules/points/ledger.ts'
import { getSpendableBalance } from '@/modules/points/repository.ts'
import { exchangePrize } from '@/modules/prizes/service.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * ポイント交換の同時実行テスト。
 *
 * 守りたいのは「同じ当選商品から 2 回ポイントが出る」ことを絶対に許さない点。
 * 交換は取消不可なので、二重付与は事後の手当てが効かない。
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
      sourceId: `prize-conc-${userId}-${amount}`,
      expiresAt: addDays(now(), 30),
    }),
  )
}

/** 抽選して当選商品を 1 件作る（当選商品は抽選経路でしか生まれない） */
async function drawOnePrize(userId: string, adminId: string, slug: string) {
  const inventory = await testPrisma.inventory.create({
    data: {
      code: `CONC-${slug}-0001`,
      cardTitle: 'ルミナ・クロニクル',
      cardName: '架空カード',
      exchangePoints: 5_000,
    },
    select: { id: true },
  })

  const at = now()
  await testPrisma.$transaction(async (tx) => {
    const campaign = await createOripa(
      tx,
      {
        slug,
        name: `交換の同時実行テスト ${slug}`,
        pricePoints: 100,
        totalSlots: 1,
        salesStartAt: new Date(at.getTime() - DAY).toISOString(),
        salesEndAt: new Date(at.getTime() + 10 * DAY).toISOString(),
        effectSetKey: 'default',
        tiers: [
          {
            code: 'S',
            name: 'S賞',
            effectTier: EffectTier.JACKPOT,
            slotCount: 1,
            displayOrder: 0,
          },
        ],
      },
      { id: adminId },
    )
    await generateSlots(tx, campaign.id, {
      allocations: [{ tierCode: 'S', inventoryIds: [inventory.id], genericPrizeCode: null }],
    })
    await publishOripa(tx, campaign.id, { id: adminId })
  })

  return testPrisma.$transaction(async (tx) => {
    const key = await tx.idempotencyKey.create({
      data: {
        userId,
        scope: 'draw',
        key: `conc-draw-${slug}`,
        requestHash: 'test',
        state: 'IN_PROGRESS',
        expiresAt: addDays(now(), 1),
      },
      select: { id: true },
    })
    return executeDraw(tx, { userId, slug, drawCount: 1, idempotencyKeyId: key.id })
  })
}

/** 本番と同じ経路（冪等性ラッパ経由）で交換する */
function exchangeViaApi(options: { userId: string; prizeId: string; key: string }) {
  return runIdempotent(
    {
      userId: options.userId,
      scope: 'prize_exchange',
      key: options.key,
      requestHash: buildRequestHash({
        body: { confirm: true },
        params: { id: options.prizeId },
        route: `/api/prizes/${options.prizeId}/exchange`,
      }),
    },
    (tx) => exchangePrize(tx, { userId: options.userId, prizeId: options.prizeId }),
  )
}

describe('同一商品への同時交換', () => {
  it('別々の冪等性キーで同時に交換しても、成立するのは 1 回だけ', async () => {
    const adminId = await createUser('prize-conc-admin@example.test', 'ADMIN')
    const userId = await createUser('prize-conc-user@example.test')
    await giveFreePoints(userId, 1_000)

    const draw = await drawOnePrize(userId, adminId, 'conc-prize-a')
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    const before = await getSpendableBalance(testPrisma, userId, now())

    const results = await Promise.allSettled([
      exchangeViaApi({ userId, prizeId: prize.userPrizeId, key: 'exchange-a' }),
      exchangeViaApi({ userId, prizeId: prize.userPrizeId, key: 'exchange-b' }),
      exchangeViaApi({ userId, prizeId: prize.userPrizeId, key: 'exchange-c' }),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)

    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: ERROR_CODES.PRIZE_NOT_UNDECIDED })
      }
    }

    // 付与は 1 回だけ
    expect(
      await testPrisma.pointLedgerEntry.count({
        where: { userId, txType: PointTxType.PRIZE_EXCHANGE },
      }),
    ).toBe(1)

    const after = await getSpendableBalance(testPrisma, userId, now())
    expect(after.freeBalance).toBe(before.freeBalance + prize.exchangePoints)

    const stored = await testPrisma.userPrize.findUniqueOrThrow({
      where: { id: prize.userPrizeId },
      select: { status: true, exchangeLedgerEntryId: true },
    })
    expect(stored.status).toBe(PrizeStatus.EXCHANGED)
    expect(stored.exchangeLedgerEntryId).not.toBeNull()

    const inventory = await testPrisma.inventory.findFirstOrThrow({
      select: { status: true },
    })
    expect(inventory.status).toBe(InventoryStatus.EXCHANGED)
  })

  it('同じ冪等性キーで同時に送ると、2 件目はリプレイになる', async () => {
    const adminId = await createUser('prize-conc-admin2@example.test', 'ADMIN')
    const userId = await createUser('prize-conc-user2@example.test')
    await giveFreePoints(userId, 1_000)

    const draw = await drawOnePrize(userId, adminId, 'conc-prize-b')
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    const key = 'same-exchange-key'
    const results = await Promise.allSettled([
      exchangeViaApi({ userId, prizeId: prize.userPrizeId, key }),
      exchangeViaApi({ userId, prizeId: prize.userPrizeId, key }),
    ])

    expect(
      results.filter((result) => result.status === 'fulfilled').length,
    ).toBeGreaterThanOrEqual(1)

    // どちらにせよ付与は 1 回だけ
    expect(
      await testPrisma.pointLedgerEntry.count({
        where: { userId, txType: PointTxType.PRIZE_EXCHANGE },
      }),
    ).toBe(1)
  })

  it('台帳の UNIQUE がアプリ層をすり抜けた二重付与も止める', async () => {
    const adminId = await createUser('prize-conc-admin3@example.test', 'ADMIN')
    const userId = await createUser('prize-conc-user3@example.test')
    await giveFreePoints(userId, 1_000)

    const draw = await drawOnePrize(userId, adminId, 'conc-prize-c')
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    await exchangeViaApi({ userId, prizeId: prize.userPrizeId, key: 'first' })

    // 状態チェックを迂回して、同じ当選商品からもう一度記帳しようとする。
    // アプリ層のバグでこの経路に入っても、DB の
    // (source_type, source_id, tx_type) UNIQUE が最後の砦になる。
    await expect(
      testPrisma.$transaction((tx) =>
        grantPoints(tx, {
          userId,
          amount: prize.exchangePoints,
          pointType: PointType.FREE,
          txType: PointTxType.PRIZE_EXCHANGE,
          sourceType: 'USER_PRIZE',
          sourceId: prize.userPrizeId,
        }),
      ),
    ).rejects.toThrow()

    expect(
      await testPrisma.pointLedgerEntry.count({
        where: { userId, txType: PointTxType.PRIZE_EXCHANGE },
      }),
    ).toBe(1)
  })
})
