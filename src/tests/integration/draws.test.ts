import { beforeEach, describe, expect, it } from 'vitest'

import {
  CampaignStatus,
  EffectTier,
  InventoryStatus,
  PointTxType,
  PointType,
  PrizeStatus,
  SlotStatus,
} from '@/generated/prisma/enums.ts'
import { ERROR_CODES } from '@/lib/api/errors.ts'
import { addDays, now } from '@/lib/datetime/index.ts'
import { getDrawDetail, listUserDraws } from '@/modules/draws/queries.ts'
import { executeDraw } from '@/modules/draws/service.ts'
import { createOripa, publishOripa } from '@/modules/oripa/service.ts'
import { generateSlots } from '@/modules/oripa/slots.ts'
import { grantPoints } from '@/modules/points/ledger.ts'
import { getSpendableBalance } from '@/modules/points/repository.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * 抽選の統合テスト。
 *
 * 確認する不変条件:
 *  - 抽選が失敗したとき、ポイントは 1 ポイントも減らない（部分適用が無い）
 *  - 同じスロットが 2 回当たらない
 *  - 結果はすべてスナップショットされ、後からマスタを変えても書き換わらない
 *  - 購入上限・販売期間・販売状態をサーバー側で判定する
 *  - 他人の抽選結果を読めない
 */

const DAY = 24 * 60 * 60 * 1000

let userId: string
let adminId: string
let campaignId: string
let campaignSlug: string

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
      sourceId: `test-${target}-${amount}-${Math.random()}`,
      expiresAt: addDays(now(), 30),
    }),
  )
}

async function createInventories(count: number, prefix: string): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const inventory = await testPrisma.inventory.create({
      data: {
        code: `${prefix}-${String(i + 1).padStart(4, '0')}`,
        cardTitle: 'ルミナ・クロニクル',
        cardName: `架空カード${i + 1}`,
        rarity: 'SR',
        exchangePoints: 1_000 + i,
        frontImageKey: `placeholder:SR:${i}:front`,
      },
      select: { id: true },
    })
    ids.push(inventory.id)
  }
  return ids
}

/**
 * 販売中オリパを作る。
 * S 賞 2 口（実在庫）+ B 賞 8 口（汎用景品）の 10 口。
 */
async function createPublishedCampaign(
  options: {
    slug?: string
    pricePoints?: number
    perUserLimit?: number | null
    salesStartAt?: Date
    salesEndAt?: Date
  } = {},
): Promise<{ id: string; slug: string }> {
  const slug = options.slug ?? 'draw-test-oripa'
  const inventoryIds = await createInventories(2, slug.toUpperCase())

  await testPrisma.genericPrize.upsert({
    where: { code: 'GENERIC-DRAW-100' },
    update: {},
    create: { code: 'GENERIC-DRAW-100', name: '汎用景品', exchangePoints: 100 },
  })

  const at = now()
  const created = await testPrisma.$transaction(async (tx) => {
    const campaign = await createOripa(
      tx,
      {
        slug,
        name: `抽選テスト用 ${slug}`,
        pricePoints: options.pricePoints ?? 100,
        totalSlots: 10,
        perUserLimit: options.perUserLimit ?? null,
        salesStartAt: (options.salesStartAt ?? new Date(at.getTime() - DAY)).toISOString(),
        salesEndAt: (options.salesEndAt ?? new Date(at.getTime() + 10 * DAY)).toISOString(),
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
      },
      { id: adminId },
    )

    await generateSlots(tx, campaign.id, {
      allocations: [
        { tierCode: 'S', inventoryIds, genericPrizeCode: 'GENERIC-DRAW-100' },
        { tierCode: 'B', inventoryIds: [], genericPrizeCode: 'GENERIC-DRAW-100' },
      ],
    })
    await publishOripa(tx, campaign.id, { id: adminId })
    return campaign
  })

  return created
}

/** 実際の API と同じく、冪等性キーの行を作ってから抽選する */
async function drawOnce(
  options: {
    user?: string
    slug?: string
    drawCount?: number
    expectedUnitPricePoints?: number
    key?: string
  } = {},
) {
  const target = options.user ?? userId
  const key = options.key ?? `draw-${Math.random()}`

  return testPrisma.$transaction(async (tx) => {
    const idempotencyKey = await tx.idempotencyKey.create({
      data: {
        userId: target,
        scope: 'draw',
        key,
        requestHash: 'test-hash',
        state: 'IN_PROGRESS',
        expiresAt: addDays(now(), 1),
      },
      select: { id: true },
    })

    return executeDraw(tx, {
      userId: target,
      slug: options.slug ?? campaignSlug,
      drawCount: options.drawCount ?? 1,
      expectedUnitPricePoints: options.expectedUnitPricePoints,
      idempotencyKeyId: idempotencyKey.id,
      requestId: 'test-request',
    })
  })
}

beforeEach(async () => {
  adminId = await createUser('draw-admin@example.test', 'ADMIN')
  userId = await createUser('drawer@example.test')
  const campaign = await createPublishedCampaign()
  campaignId = campaign.id
  campaignSlug = campaign.slug
})

describe('1 回抽選', () => {
  it('1 口引くとスロットが 1 件 DRAWN になり、当選商品が 1 件できる', async () => {
    await giveFreePoints(userId, 1_000)

    const result = await drawOnce()

    expect(result.drawCount).toBe(1)
    expect(result.prizes).toHaveLength(1)
    expect(result.totalPricePoints).toBe(100)
    expect(result.remainingSlots).toBe(9)

    const drawn = await testPrisma.oripaSlot.count({
      where: { campaignId, status: SlotStatus.DRAWN },
    })
    expect(drawn).toBe(1)

    const prizes = await testPrisma.userPrize.findMany({ where: { userId } })
    expect(prizes).toHaveLength(1)
    expect(prizes[0]?.status).toBe(PrizeStatus.UNDECIDED)
  })

  it('ポイントが価格ぶん減り、台帳に DRAW として記帳される', async () => {
    await giveFreePoints(userId, 1_000)

    await drawOnce()

    const balance = await getSpendableBalance(testPrisma, userId, now())
    expect(balance.paidBalance + balance.freeBalance).toBe(900)

    const entries = await testPrisma.pointLedgerEntry.findMany({
      where: { userId, txType: PointTxType.DRAW },
      select: { amount: true, sourceType: true },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.amount).toBe(-100)
    expect(entries[0]?.sourceType).toBe('DRAW_REQUEST')
  })

  it('抽選記録が台帳エントリと 1:1 で結び付く', async () => {
    await giveFreePoints(userId, 1_000)
    const result = await drawOnce()

    const transaction = await testPrisma.drawTransaction.findUniqueOrThrow({
      where: { id: result.drawTransactionId },
      select: { ledgerEntryId: true, unitPricePoints: true, totalPricePoints: true },
    })

    const entry = await testPrisma.pointLedgerEntry.findUniqueOrThrow({
      where: { id: transaction.ledgerEntryId },
      select: { txType: true, amount: true },
    })
    expect(entry.txType).toBe(PointTxType.DRAW)
    expect(entry.amount).toBe(-transaction.totalPricePoints)
  })

  it('当選在庫が WON になる（汎用景品のときは在庫を触らない）', async () => {
    await giveFreePoints(userId, 10_000)

    // 10 口すべて引けば S 賞 2 件（実在庫）が必ず含まれる
    await drawOnce({ drawCount: 10 })

    const won = await testPrisma.inventory.count({ where: { status: InventoryStatus.WON } })
    expect(won).toBe(2)
  })
})

describe('10 連抽選', () => {
  it('10 件の結果が sequence 0..9 で記録される', async () => {
    await giveFreePoints(userId, 10_000)

    const result = await drawOnce({ drawCount: 10 })

    expect(result.prizes).toHaveLength(10)
    expect(result.prizes.map((prize) => prize.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(result.totalPricePoints).toBe(1_000)
    expect(result.remainingSlots).toBe(0)
  })

  it('同じスロットが 2 回当たらない', async () => {
    await giveFreePoints(userId, 10_000)
    await drawOnce({ drawCount: 10 })

    const slotIds = await testPrisma.drawResult.findMany({ select: { slotId: true } })
    expect(new Set(slotIds.map((row) => row.slotId)).size).toBe(10)
  })

  it('完売すると状態が SOLD_OUT になる', async () => {
    await giveFreePoints(userId, 10_000)
    await drawOnce({ drawCount: 10 })

    const campaign = await testPrisma.oripaCampaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { status: true, remainingSlots: true, soldOutAt: true },
    })
    expect(campaign.status).toBe(CampaignStatus.SOLD_OUT)
    expect(campaign.remainingSlots).toBe(0)
    expect(campaign.soldOutAt).not.toBeNull()
  })

  it('完売後は引けない', async () => {
    await giveFreePoints(userId, 20_000)
    await drawOnce({ drawCount: 10 })

    await expect(drawOnce()).rejects.toMatchObject({
      code: ERROR_CODES.CAMPAIGN_NOT_ON_SALE,
    })
  })
})

describe('失敗時にポイントが減らないこと', () => {
  it('残り口数を超える要求では、ポイントも口数も一切変わらない', async () => {
    await giveFreePoints(userId, 10_000)
    // 先に 5 口引いて残り 5 口にする
    await drawOnce({ drawCount: 1 })
    await drawOnce({ drawCount: 1 })
    await drawOnce({ drawCount: 1 })
    await drawOnce({ drawCount: 1 })
    await drawOnce({ drawCount: 1 })

    const before = await getSpendableBalance(testPrisma, userId, now())

    await expect(drawOnce({ drawCount: 10 })).rejects.toMatchObject({
      code: ERROR_CODES.INSUFFICIENT_SLOTS,
    })

    const after = await getSpendableBalance(testPrisma, userId, now())
    expect(after.freeBalance).toBe(before.freeBalance)
    expect(after.paidBalance).toBe(before.paidBalance)

    const campaign = await testPrisma.oripaCampaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { remainingSlots: true },
    })
    expect(campaign.remainingSlots).toBe(5)
  })

  it('ポイント不足のときスロットは消費されない', async () => {
    await giveFreePoints(userId, 50)

    await expect(drawOnce()).rejects.toMatchObject({
      code: ERROR_CODES.INSUFFICIENT_POINTS,
    })

    const drawn = await testPrisma.oripaSlot.count({
      where: { campaignId, status: SlotStatus.DRAWN },
    })
    expect(drawn).toBe(0)

    const campaign = await testPrisma.oripaCampaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { remainingSlots: true },
    })
    expect(campaign.remainingSlots).toBe(10)

    // 抽選記録も作られていない
    expect(await testPrisma.drawTransaction.count()).toBe(0)
  })

  it('残高ちょうどなら引ける（境界値）', async () => {
    await giveFreePoints(userId, 100)

    const result = await drawOnce()
    expect(result.balanceAfter).toBe(0)
  })
})

describe('サーバー側の判定', () => {
  it('販売前のオリパは引けない', async () => {
    const at = now()
    const scheduled = await createPublishedCampaign({
      slug: 'draw-scheduled',
      salesStartAt: new Date(at.getTime() + DAY),
      salesEndAt: new Date(at.getTime() + 10 * DAY),
    })
    await giveFreePoints(userId, 1_000)

    await expect(drawOnce({ slug: scheduled.slug })).rejects.toMatchObject({
      code: ERROR_CODES.CAMPAIGN_NOT_ON_SALE,
    })
  })

  it('販売停止中のオリパは引けない', async () => {
    await giveFreePoints(userId, 1_000)
    await testPrisma.oripaCampaign.update({
      where: { id: campaignId },
      data: { status: CampaignStatus.SUSPENDED, suspendedAt: now(), suspendReason: 'テスト' },
    })

    await expect(drawOnce()).rejects.toMatchObject({
      code: ERROR_CODES.CAMPAIGN_NOT_ON_SALE,
    })
  })

  it('販売期間を過ぎたら引けない（status が ACTIVE のままでも）', async () => {
    await giveFreePoints(userId, 1_000)
    // 期間だけを過去へずらす。status は ACTIVE のまま。
    await testPrisma.oripaCampaign.update({
      where: { id: campaignId },
      data: { salesEndAt: new Date(now().getTime() - 1_000) },
    })

    await expect(drawOnce()).rejects.toMatchObject({
      code: ERROR_CODES.CAMPAIGN_OUT_OF_PERIOD,
    })
  })

  it('許可されていない口数を拒否する', async () => {
    await giveFreePoints(userId, 10_000)

    await expect(drawOnce({ drawCount: 3 })).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_DRAW_COUNT,
    })
    await expect(drawOnce({ drawCount: 0 })).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_DRAW_COUNT,
    })
  })

  it('表示価格がサーバー価格と違えば拒否する', async () => {
    await giveFreePoints(userId, 1_000)

    await expect(drawOnce({ expectedUnitPricePoints: 50 })).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
    })
  })

  it('下書きのオリパは引けない（公開前は存在しないものとして扱う）', async () => {
    await giveFreePoints(userId, 1_000)
    const draft = await testPrisma.$transaction((tx) =>
      createOripa(
        tx,
        {
          slug: 'draw-draft',
          name: '下書き',
          pricePoints: 100,
          totalSlots: 1,
          salesStartAt: new Date(now().getTime() - DAY).toISOString(),
          salesEndAt: new Date(now().getTime() + DAY).toISOString(),
          effectSetKey: 'default',
          tiers: [
            {
              code: 'A',
              name: 'A賞',
              effectTier: EffectTier.NORMAL,
              slotCount: 1,
              displayOrder: 0,
            },
          ],
        },
        { id: adminId },
      ),
    )
    expect(draft.slug).toBe('draw-draft')

    await expect(drawOnce({ slug: 'draw-draft' })).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    })
  })
})

describe('購入上限', () => {
  it('上限に達したら引けない', async () => {
    const limited = await createPublishedCampaign({ slug: 'draw-limited', perUserLimit: 2 })
    await giveFreePoints(userId, 10_000)

    await drawOnce({ slug: limited.slug })
    await drawOnce({ slug: limited.slug })

    await expect(drawOnce({ slug: limited.slug })).rejects.toMatchObject({
      code: ERROR_CODES.PURCHASE_LIMIT_EXCEEDED,
    })
  })

  it('1 回の口数が上限を超える場合も拒否する', async () => {
    const limited = await createPublishedCampaign({ slug: 'draw-limited-2', perUserLimit: 5 })
    await giveFreePoints(userId, 10_000)

    await expect(drawOnce({ slug: limited.slug, drawCount: 10 })).rejects.toMatchObject({
      code: ERROR_CODES.PURCHASE_LIMIT_EXCEEDED,
    })
  })

  it('上限はユーザーごとに数える', async () => {
    const limited = await createPublishedCampaign({ slug: 'draw-limited-3', perUserLimit: 1 })
    const other = await createUser('other-drawer@example.test')
    await giveFreePoints(userId, 10_000)
    await giveFreePoints(other, 10_000)

    await drawOnce({ slug: limited.slug })
    // 別ユーザーは自分の上限を使える
    await drawOnce({ slug: limited.slug, user: other })

    const counters = await testPrisma.userCampaignCounter.findMany({
      where: { campaign: { slug: limited.slug } },
      select: { drawnCount: true },
    })
    expect(counters).toHaveLength(2)
    expect(counters.every((counter) => counter.drawnCount === 1)).toBe(true)
  })

  it('上限なしのオリパではカウンタだけ増える', async () => {
    await giveFreePoints(userId, 10_000)
    await drawOnce()
    await drawOnce()

    const counter = await testPrisma.userCampaignCounter.findUniqueOrThrow({
      where: { userId_campaignId: { userId, campaignId } },
      select: { drawnCount: true },
    })
    expect(counter.drawnCount).toBe(2)
  })
})

describe('スナップショット', () => {
  it('在庫マスタを変えても過去の抽選結果は変わらない', async () => {
    await giveFreePoints(userId, 10_000)
    const result = await drawOnce({ drawCount: 10 })

    const before = await getDrawDetail(result.drawTransactionId, userId)

    // 在庫の名前と交換ポイントを変える
    await testPrisma.inventory.updateMany({
      where: { status: InventoryStatus.WON },
      data: { cardName: '書き換え後の名前', exchangePoints: 999_999 },
    })

    const after = await getDrawDetail(result.drawTransactionId, userId)
    expect(after.results).toEqual(before.results)
    expect(after.results.some((row) => row.name === '書き換え後の名前')).toBe(false)
  })

  it('当選商品にも抽選時点の交換ポイントが残る', async () => {
    await giveFreePoints(userId, 10_000)
    await drawOnce({ drawCount: 10 })

    const prizes = await testPrisma.userPrize.findMany({
      where: { userId, inventoryId: { not: null } },
      select: { exchangePoints: true },
      orderBy: { exchangePoints: 'asc' },
    })

    await testPrisma.inventory.updateMany({
      where: { status: InventoryStatus.WON },
      data: { exchangePoints: 1 },
    })

    const after = await testPrisma.userPrize.findMany({
      where: { userId, inventoryId: { not: null } },
      select: { exchangePoints: true },
      orderBy: { exchangePoints: 'asc' },
    })
    expect(after).toEqual(prizes)
  })
})

describe('結果の参照', () => {
  it('他人の抽選結果は 404 になる', async () => {
    await giveFreePoints(userId, 1_000)
    const result = await drawOnce()
    const other = await createUser('peeker@example.test')

    await expect(getDrawDetail(result.drawTransactionId, other)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    })
  })

  it('結果にスロット ID と抽選順を含めない', async () => {
    await giveFreePoints(userId, 1_000)
    const result = await drawOnce()

    const detail = await getDrawDetail(result.drawTransactionId, userId)
    const serialized = JSON.stringify(detail)
    expect(serialized).not.toContain('slotId')
    expect(serialized).not.toContain('drawOrder')
  })

  it('履歴が新しい順に並び、未選択件数が出る', async () => {
    // 1 口 + 10 口で 11 口いるので、10 連は別のオリパで引く
    const second = await createPublishedCampaign({ slug: 'draw-history-2' })
    await giveFreePoints(userId, 10_000)
    await drawOnce()
    await drawOnce({ slug: second.slug, drawCount: 10 })

    const history = await listUserDraws(userId, { page: 1, perPage: 20 })
    expect(history.total).toBe(2)
    expect(history.items[0]?.drawCount).toBe(10)
    expect(history.items[0]?.undecidedCount).toBe(10)
    expect(history.items[1]?.undecidedCount).toBe(1)
  })

  it('履歴には自分の抽選しか出ない', async () => {
    const other = await createUser('another-drawer@example.test')
    await giveFreePoints(userId, 1_000)
    await giveFreePoints(other, 1_000)
    await drawOnce()
    await drawOnce({ user: other })

    const mine = await listUserDraws(userId, { page: 1, perPage: 20 })
    expect(mine.total).toBe(1)
  })
})

describe('台帳の追記専用性', () => {
  it('抽選の記録は UPDATE できない', async () => {
    await giveFreePoints(userId, 1_000)
    const result = await drawOnce()

    await expect(
      testPrisma.drawTransaction.update({
        where: { id: result.drawTransactionId },
        data: { drawCount: 99 },
      }),
    ).rejects.toThrow(/APPEND_ONLY_VIOLATION/)
  })

  it('抽選結果は DELETE できない', async () => {
    await giveFreePoints(userId, 1_000)
    const result = await drawOnce()

    const drawResult = await testPrisma.drawResult.findFirstOrThrow({
      where: { drawTransactionId: result.drawTransactionId },
      select: { id: true },
    })

    await expect(
      testPrisma.drawResult.delete({ where: { id: drawResult.id } }),
    ).rejects.toThrow(/APPEND_ONLY_VIOLATION/)
  })
})
