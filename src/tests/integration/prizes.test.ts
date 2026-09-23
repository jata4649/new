import { beforeEach, describe, expect, it } from 'vitest'

import {
  EffectTier,
  InventoryStatus,
  PointTxType,
  PointType,
  PrizeStatus,
} from '@/generated/prisma/enums.ts'
import { ERROR_CODES } from '@/lib/api/errors.ts'
import { addDays, now } from '@/lib/datetime/index.ts'
import { executeDraw } from '@/modules/draws/service.ts'
import { createOripa, publishOripa } from '@/modules/oripa/service.ts'
import { generateSlots } from '@/modules/oripa/slots.ts'
import { grantPoints } from '@/modules/points/ledger.ts'
import { getSpendableBalance } from '@/modules/points/repository.ts'
import { listUserPrizes } from '@/modules/prizes/queries.ts'
import { exchangePrize } from '@/modules/prizes/service.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * 当選商品とポイント交換の統合テスト。
 *
 * 確認する不変条件:
 *  - 交換は 1 回しかできない（二重付与しない）
 *  - 交換に失敗したらポイントは 1 ポイントも増えない
 *  - 交換で付与されるのは無償ポイント
 *  - 物理在庫が EXCHANGED になる
 *  - 他人の当選商品を交換できない
 */

const DAY = 24 * 60 * 60 * 1000

let userId: string
let adminId: string

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

async function giveFreePoints(target: string, amount: number): Promise<void> {
  await testPrisma.$transaction((tx) =>
    grantPoints(tx, {
      userId: target,
      amount,
      pointType: PointType.FREE,
      txType: PointTxType.BONUS,
      sourceType: 'TEST',
      sourceId: `prize-test-${target}-${Math.random()}`,
      expiresAt: addDays(now(), 30),
    }),
  )
}

/**
 * 抽選で当選商品を作る。
 *
 * 当選商品は抽選処理でしか生まれないので、テストでも同じ経路を通す。
 * 直接 INSERT すると、実際には作れないデータでテストしてしまう。
 */
async function drawPrizes(options: { user?: string; drawCount?: number; slug?: string } = {}) {
  const target = options.user ?? userId
  const slug = options.slug ?? 'prize-test-oripa'

  const existing = await testPrisma.oripaCampaign.findUnique({ where: { slug } })
  if (!existing) {
    const inventory = await testPrisma.inventory.create({
      data: {
        code: `PRIZE-${slug}-0001`,
        cardTitle: 'ルミナ・クロニクル',
        cardName: '架空の当たりカード',
        rarity: 'UR',
        exchangePoints: 5_000,
        frontImageKey: 'placeholder:UR:200:front',
      },
      select: { id: true },
    })

    await testPrisma.genericPrize.upsert({
      where: { code: 'GENERIC-PRIZE-100' },
      update: {},
      create: {
        code: 'GENERIC-PRIZE-100',
        name: 'ポイント還元アイテム',
        exchangePoints: 100,
        // 汎用景品は発送できない（ポイント交換のみ）
        shippable: false,
      },
    })

    const at = now()
    await testPrisma.$transaction(async (tx) => {
      const campaign = await createOripa(
        tx,
        {
          slug,
          name: '当選商品テスト用',
          pricePoints: 100,
          totalSlots: 10,
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
            {
              code: 'B',
              name: 'B賞',
              effectTier: EffectTier.NORMAL,
              slotCount: 9,
              displayOrder: 1,
            },
          ],
        },
        { id: adminId },
      )
      await generateSlots(tx, campaign.id, {
        allocations: [
          {
            tierCode: 'S',
            inventoryIds: [inventory.id],
            genericPrizeCode: 'GENERIC-PRIZE-100',
          },
          { tierCode: 'B', inventoryIds: [], genericPrizeCode: 'GENERIC-PRIZE-100' },
        ],
      })
      await publishOripa(tx, campaign.id, { id: adminId })
    })
  }

  return testPrisma.$transaction(async (tx) => {
    const key = await tx.idempotencyKey.create({
      data: {
        userId: target,
        scope: 'draw',
        key: `prize-draw-${Math.random()}`,
        requestHash: 'test',
        state: 'IN_PROGRESS',
        expiresAt: addDays(now(), 1),
      },
      select: { id: true },
    })
    return executeDraw(tx, {
      userId: target,
      slug,
      drawCount: options.drawCount ?? 1,
      idempotencyKeyId: key.id,
    })
  })
}

function exchange(prizeId: string, options: { user?: string; expected?: number } = {}) {
  return testPrisma.$transaction((tx) =>
    exchangePrize(tx, {
      userId: options.user ?? userId,
      prizeId,
      expectedExchangePoints: options.expected,
    }),
  )
}

beforeEach(async () => {
  adminId = await createUser('prize-admin@example.test', 'ADMIN')
  userId = await createUser('prize-user@example.test')
  await giveFreePoints(userId, 10_000)
})

describe('ポイント交換', () => {
  it('交換すると無償ポイントが付与され、状態が EXCHANGED になる', async () => {
    const draw = await drawPrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    const before = await getSpendableBalance(testPrisma, userId, now())
    const result = await exchange(prize.userPrizeId)

    expect(result.grantedPoints).toBe(prize.exchangePoints)

    const after = await getSpendableBalance(testPrisma, userId, now())
    expect(after.freeBalance).toBe(before.freeBalance + prize.exchangePoints)
    // 有償ポイントは増えない（対価を伴って発行したものではないため）
    expect(after.paidBalance).toBe(before.paidBalance)

    const stored = await testPrisma.userPrize.findUniqueOrThrow({
      where: { id: prize.userPrizeId },
      select: { status: true, exchangedAt: true, exchangeLedgerEntryId: true },
    })
    expect(stored.status).toBe(PrizeStatus.EXCHANGED)
    expect(stored.exchangedAt).not.toBeNull()
    expect(stored.exchangeLedgerEntryId).not.toBeNull()
  })

  it('台帳に PRIZE_EXCHANGE として当選商品 ID つきで記帳される', async () => {
    const draw = await drawPrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    await exchange(prize.userPrizeId)

    const entries = await testPrisma.pointLedgerEntry.findMany({
      where: { userId, txType: PointTxType.PRIZE_EXCHANGE },
      select: { amount: true, sourceType: true, sourceId: true, pointType: true },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.amount).toBe(prize.exchangePoints)
    expect(entries[0]?.sourceType).toBe('USER_PRIZE')
    expect(entries[0]?.sourceId).toBe(prize.userPrizeId)
    expect(entries[0]?.pointType).toBe(PointType.FREE)
  })

  it('2 回目の交換は拒否され、ポイントも増えない', async () => {
    const draw = await drawPrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    await exchange(prize.userPrizeId)
    const afterFirst = await getSpendableBalance(testPrisma, userId, now())

    await expect(exchange(prize.userPrizeId)).rejects.toMatchObject({
      code: ERROR_CODES.PRIZE_NOT_UNDECIDED,
    })

    const afterSecond = await getSpendableBalance(testPrisma, userId, now())
    expect(afterSecond.freeBalance).toBe(afterFirst.freeBalance)

    expect(
      await testPrisma.pointLedgerEntry.count({
        where: { userId, txType: PointTxType.PRIZE_EXCHANGE },
      }),
    ).toBe(1)
  })

  it('物理在庫が当選済みから交換済みになる', async () => {
    // 10 連で引けば S 賞（物理在庫）が必ず含まれる
    const draw = await drawPrizes({ drawCount: 10 })

    const physical = await testPrisma.userPrize.findFirstOrThrow({
      where: { userId, inventoryId: { not: null } },
      select: { id: true, inventoryId: true },
    })

    await exchange(physical.id)

    const inventory = await testPrisma.inventory.findUniqueOrThrow({
      where: { id: physical.inventoryId ?? '' },
      select: { status: true },
    })
    expect(inventory.status).toBe(InventoryStatus.EXCHANGED)
    expect(draw.prizes).toHaveLength(10)
  })

  it('汎用景品（在庫なし）も交換できる', async () => {
    const draw = await drawPrizes({ drawCount: 10 })
    expect(draw.prizes).toHaveLength(10)

    const generic = await testPrisma.userPrize.findFirstOrThrow({
      where: { userId, inventoryId: null },
      select: { id: true, exchangePoints: true },
    })

    const result = await exchange(generic.id)
    expect(result.grantedPoints).toBe(generic.exchangePoints)
  })

  it('他人の当選商品は交換できない（404）', async () => {
    const draw = await drawPrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    const other = await createUser('prize-intruder@example.test')

    await expect(exchange(prize.userPrizeId, { user: other })).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    })

    // 対象の商品は未選択のまま
    const stored = await testPrisma.userPrize.findUniqueOrThrow({
      where: { id: prize.userPrizeId },
      select: { status: true },
    })
    expect(stored.status).toBe(PrizeStatus.UNDECIDED)
  })

  it('表示していた交換ポイントがサーバーと違えば拒否する', async () => {
    const draw = await drawPrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    await expect(
      exchange(prize.userPrizeId, { expected: prize.exchangePoints + 1 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR })

    // 拒否されたのでポイントは増えていない
    expect(
      await testPrisma.pointLedgerEntry.count({
        where: { userId, txType: PointTxType.PRIZE_EXCHANGE },
      }),
    ).toBe(0)
  })

  it('交換で得たポイントは有効期限を持つ', async () => {
    const draw = await drawPrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    const result = await exchange(prize.userPrizeId)
    expect(result.expiresAt.getTime()).toBeGreaterThan(now().getTime())
  })

  it('交換で得たポイントで次の抽選ができる', async () => {
    const draw = await drawPrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    await exchange(prize.userPrizeId)
    const second = await drawPrizes()
    expect(second.prizes).toHaveLength(1)
  })
})

describe('当選商品の一覧', () => {
  it('未選択が先頭に並ぶ', async () => {
    const draw = await drawPrizes({ drawCount: 10 })
    const first = draw.prizes[0]
    if (!first) throw new Error('当選商品がありません')

    await exchange(first.userPrizeId)

    const list = await listUserPrizes(userId, { page: 1, perPage: 24 })
    expect(list.total).toBe(10)
    expect(list.undecidedTotal).toBe(9)
    expect(list.items[0]?.status).toBe(PrizeStatus.UNDECIDED)
    expect(list.items.at(-1)?.status).toBe(PrizeStatus.EXCHANGED)
  })

  it('状態で絞り込める', async () => {
    const draw = await drawPrizes({ drawCount: 10 })
    const first = draw.prizes[0]
    if (!first) throw new Error('当選商品がありません')
    await exchange(first.userPrizeId)

    const exchanged = await listUserPrizes(userId, {
      page: 1,
      perPage: 24,
      status: PrizeStatus.EXCHANGED,
    })
    expect(exchanged.total).toBe(1)
    // 絞り込んでも未選択の総数は全体の値を返す（バッジ表示用）
    expect(exchanged.undecidedTotal).toBe(9)
  })

  it('他人の当選商品は出ない', async () => {
    const other = await createUser('prize-other@example.test')
    await giveFreePoints(other, 10_000)

    await drawPrizes()
    await drawPrizes({ user: other })

    const mine = await listUserPrizes(userId, { page: 1, perPage: 24 })
    expect(mine.total).toBe(1)
  })

  it('抽選時のスナップショットを返す（在庫マスタを変えても変わらない）', async () => {
    await drawPrizes({ drawCount: 10 })

    const before = await listUserPrizes(userId, { page: 1, perPage: 24 })

    await testPrisma.inventory.updateMany({
      data: { cardName: '書き換え後', exchangePoints: 1 },
    })

    const after = await listUserPrizes(userId, { page: 1, perPage: 24 })
    expect(after.items).toEqual(before.items)
    expect(after.items.some((item) => item.name === '書き換え後')).toBe(false)
  })

  it('物理カードと汎用景品を区別できる', async () => {
    await drawPrizes({ drawCount: 10 })

    const list = await listUserPrizes(userId, { page: 1, perPage: 24 })
    expect(list.items.some((item) => item.isPhysical)).toBe(true)
    expect(list.items.some((item) => !item.isPhysical)).toBe(true)

    // 汎用景品は発送できない設定にしてある
    const generic = list.items.find((item) => !item.isPhysical)
    expect(generic?.shippable).toBe(false)
  })
})
