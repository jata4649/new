import { describe, expect, it } from 'vitest'

import {
  EffectTier,
  InventoryStatus,
  PointTxType,
  PointType,
  PrizeStatus,
  ShippingStatus,
} from '@/generated/prisma/enums.ts'
import { ERROR_CODES } from '@/lib/api/errors.ts'
import { addDays, now } from '@/lib/datetime/index.ts'
import { createAddress } from '@/modules/addresses/service.ts'
import { executeDraw } from '@/modules/draws/service.ts'
import { createOripa, publishOripa } from '@/modules/oripa/service.ts'
import { generateSlots } from '@/modules/oripa/slots.ts'
import { grantPoints } from '@/modules/points/ledger.ts'
import { exchangePrize } from '@/modules/prizes/service.ts'
import {
  cancelShippingRequest,
  requestShipping,
  updateShippingStatus,
} from '@/modules/shipping/service.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * 発送申請の同時実行テスト。
 *
 * 守りたいのは次の 3 点。
 *  - 同じ当選商品が 2 件の有効な発送申請に入らない（INV-7）
 *  - 「ポイント交換」と「発送申請」が同時に来ても、成立するのは片方だけ
 *  - 取消しと発送作業が同時に来ても、両方は成立しない
 *
 * いずれも DB 制約だけでも壊れたデータは防げるが、それだと利用者へ
 * 一意制約違反（500）が返る。行ロックがあることで正しい 409 になる。
 * その差を「エラーコードが 409 系であること」で検証する。
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
      sourceId: `ship-conc-${userId}-${Math.random()}`,
      expiresAt: addDays(now(), 30),
    }),
  )
}

async function newIdempotencyKey(userId: string, scope: string): Promise<string> {
  const key = await testPrisma.idempotencyKey.create({
    data: {
      userId,
      scope,
      key: `${scope}-${Math.random()}`,
      requestHash: 'test',
      state: 'IN_PROGRESS',
      expiresAt: addDays(now(), 1),
    },
    select: { id: true },
  })
  return key.id
}

/**
 * 発送可能な当選商品を持つユーザーを 1 人用意する。
 *
 * 当選商品は抽選処理でしか生まれないので、テストでも同じ経路を通す。
 * 物理在庫だけのオリパを使い、shippable が必ず true になるようにする。
 */
async function setupUserWithPrizes(
  label: string,
  drawCount = 1,
): Promise<{ userId: string; adminId: string; addressId: string; prizeIds: string[] }> {
  const adminId = await createUser(`ship-conc-admin-${label}@example.test`, 'ADMIN')
  const userId = await createUser(`ship-conc-user-${label}@example.test`)
  await giveFreePoints(userId, 10_000)

  const slug = `ship-conc-${label}`
  const inventories = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      testPrisma.inventory.create({
        data: {
          code: `SHIPCONC-${label}-${String(index).padStart(4, '0')}`,
          cardTitle: 'ルミナ・クロニクル',
          cardName: `架空の発送対象カード ${index}`,
          rarity: 'SR',
          exchangePoints: 1_000,
          frontImageKey: 'placeholder:SR:200:front',
        },
        select: { id: true },
      }),
    ),
  )

  const at = now()
  await testPrisma.$transaction(async (tx) => {
    const campaign = await createOripa(
      tx,
      {
        slug,
        name: `発送同時実行テスト ${label}`,
        pricePoints: 100,
        totalSlots: 20,
        salesStartAt: new Date(at.getTime() - DAY).toISOString(),
        salesEndAt: new Date(at.getTime() + 10 * DAY).toISOString(),
        effectSetKey: 'default',
        tiers: [
          {
            code: 'A',
            name: 'A賞',
            effectTier: EffectTier.GOLD,
            slotCount: 20,
            displayOrder: 0,
          },
        ],
      },
      { id: adminId },
    )
    await generateSlots(tx, campaign.id, {
      allocations: [{ tierCode: 'A', inventoryIds: inventories.map((i) => i.id) }],
    })
    await publishOripa(tx, campaign.id, { id: adminId })
  })

  const draw = await testPrisma.$transaction(async (tx) => {
    const keyId = await tx.idempotencyKey.create({
      data: {
        userId,
        scope: 'draw',
        key: `ship-conc-draw-${Math.random()}`,
        requestHash: 'test',
        state: 'IN_PROGRESS',
        expiresAt: addDays(now(), 1),
      },
      select: { id: true },
    })
    return executeDraw(tx, { userId, slug, drawCount, idempotencyKeyId: keyId.id })
  })

  const address = await testPrisma.$transaction((tx) =>
    createAddress(tx, {
      userId,
      input: {
        recipientName: '架空 太郎',
        postalCode: '150-0001',
        prefecture: '東京都',
        city: '渋谷区',
        addressLine1: '神南 1-2-3',
        addressLine2: null,
        phoneNumber: '09012345678',
        isDefault: true,
      },
    }),
  )

  return {
    userId,
    adminId,
    addressId: address.id,
    prizeIds: draw.prizes.map((prize) => prize.userPrizeId),
  }
}

async function requestShippingOnce(
  userId: string,
  prizeIds: string[],
  addressId: string,
): Promise<{ shippingRequestId: string }> {
  const keyId = await newIdempotencyKey(userId, 'shipping_request')
  return testPrisma.$transaction((tx) =>
    requestShipping(tx, { userId, prizeIds, addressId, idempotencyKeyId: keyId }),
  )
}

/** 拒否された理由のエラーコードを取り出す（数え上げ用） */
function codesOf(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .filter((result) => result.status === 'rejected')
    .map((result) => {
      const reason: unknown = (result as PromiseRejectedResult).reason
      return typeof reason === 'object' && reason !== null && 'code' in reason
        ? String((reason as { code: unknown }).code)
        : 'UNKNOWN'
    })
}

/* -------------------------------------------------------------------------- */

describe('発送申請の同時実行', () => {
  it('同じ商品へ同時に 3 件申請しても、成立するのは 1 件だけ', async () => {
    const { userId, addressId, prizeIds } = await setupUserWithPrizes('dup')
    const prizeId = prizeIds[0]
    if (!prizeId) throw new Error('当選商品がありません')

    const results = await Promise.allSettled([
      requestShippingOnce(userId, [prizeId], addressId),
      requestShippingOnce(userId, [prizeId], addressId),
      requestShippingOnce(userId, [prizeId], addressId),
    ])

    const succeeded = results.filter((result) => result.status === 'fulfilled')
    expect(succeeded).toHaveLength(1)

    // 有効な申請は 1 件、有効な明細も 1 件
    const activeItems = await testPrisma.shippingRequestItem.count({
      where: { userPrizeId: prizeId, cancelledAt: null },
    })
    expect(activeItems).toBe(1)

    const prize = await testPrisma.userPrize.findUniqueOrThrow({
      where: { id: prizeId },
      select: { status: true },
    })
    expect(prize.status).toBe(PrizeStatus.SHIPPING_REQUESTED)
  })

  it('失敗した側には 409 系が返る（一意制約違反の 500 にしない）', async () => {
    const { userId, addressId, prizeIds } = await setupUserWithPrizes('conflict')
    const prizeId = prizeIds[0]
    if (!prizeId) throw new Error('当選商品がありません')

    const results = await Promise.allSettled([
      requestShippingOnce(userId, [prizeId], addressId),
      requestShippingOnce(userId, [prizeId], addressId),
    ])

    const codes = codesOf(results)
    expect(codes).toHaveLength(1)
    // 行ロックが効いていれば、後続は確定後の状態を読んで正しい 409 を返す
    expect([ERROR_CODES.PRIZE_ALREADY_REQUESTED, ERROR_CODES.PRIZE_NOT_UNDECIDED]).toContain(
      codes[0],
    )
  })

  it('ポイント交換と発送申請が同時に来ても、成立するのは片方だけ', async () => {
    const { userId, addressId, prizeIds } = await setupUserWithPrizes('race')
    const prizeId = prizeIds[0]
    if (!prizeId) throw new Error('当選商品がありません')

    const results = await Promise.allSettled([
      testPrisma.$transaction((tx) => exchangePrize(tx, { userId, prizeId })),
      requestShippingOnce(userId, [prizeId], addressId),
    ])

    const succeeded = results.filter((result) => result.status === 'fulfilled')
    expect(succeeded).toHaveLength(1)

    const prize = await testPrisma.userPrize.findUniqueOrThrow({
      where: { id: prizeId },
      select: { status: true, exchangeLedgerEntryId: true },
    })

    // 交換が勝ったなら記帳があり、申請が勝ったなら記帳は無い。
    // どちらでもよいが、「交換済みなのに申請中」は絶対に無い。
    if (prize.status === PrizeStatus.EXCHANGED) {
      expect(prize.exchangeLedgerEntryId).not.toBeNull()
      const activeItems = await testPrisma.shippingRequestItem.count({
        where: { userPrizeId: prizeId, cancelledAt: null },
      })
      expect(activeItems).toBe(0)
    } else {
      expect(prize.status).toBe(PrizeStatus.SHIPPING_REQUESTED)
      expect(prize.exchangeLedgerEntryId).toBeNull()
    }
  })

  it('10 件をまとめた申請と 1 件だけの申請が競合しても、商品が重複しない', async () => {
    const { userId, addressId, prizeIds } = await setupUserWithPrizes('overlap', 10)
    const first = prizeIds[0]
    if (!first || prizeIds.length !== 10) throw new Error('当選商品が揃っていません')

    const results = await Promise.allSettled([
      requestShippingOnce(userId, prizeIds, addressId),
      requestShippingOnce(userId, [first], addressId),
    ])

    const succeeded = results.filter((result) => result.status === 'fulfilled')
    expect(succeeded).toHaveLength(1)

    // どちらが勝っても、重複して申請中になっている商品は無い
    const activeItems = await testPrisma.shippingRequestItem.count({
      where: { userPrizeId: first, cancelledAt: null },
    })
    expect(activeItems).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */

describe('取消しと発送作業の同時実行', () => {
  it('取消しと検品開始が同時に来ても、両方は成立しない', async () => {
    const { userId, adminId, addressId, prizeIds } = await setupUserWithPrizes('cancel-race')
    const prizeId = prizeIds[0]
    if (!prizeId) throw new Error('当選商品がありません')

    const { shippingRequestId } = await requestShippingOnce(userId, [prizeId], addressId)

    const results = await Promise.allSettled([
      testPrisma.$transaction((tx) =>
        cancelShippingRequest(tx, {
          actorId: userId,
          actorType: 'USER',
          shippingRequestId,
          reason: '住所を間違えたため',
        }),
      ),
      testPrisma.$transaction((tx) =>
        updateShippingStatus(tx, {
          adminId,
          shippingRequestId,
          input: { status: ShippingStatus.CHECKING },
        }),
      ),
    ])

    const succeeded = results.filter((result) => result.status === 'fulfilled')
    expect(succeeded).toHaveLength(1)

    const shipment = await testPrisma.shippingRequest.findUniqueOrThrow({
      where: { id: shippingRequestId },
      select: { status: true, cancelledAt: true, cancelReason: true },
    })

    // 取消しが勝ったなら理由と日時が揃い、商品は未選択へ戻っている。
    // 検品が勝ったなら取消しの痕跡は無い。中途半端な状態は無い。
    const prize = await testPrisma.userPrize.findUniqueOrThrow({
      where: { id: prizeId },
      select: { status: true, shippingRequestedAt: true },
    })

    if (shipment.status === ShippingStatus.CANCELLED) {
      expect(shipment.cancelledAt).not.toBeNull()
      expect(shipment.cancelReason).not.toBeNull()
      expect(prize.status).toBe(PrizeStatus.UNDECIDED)
      expect(prize.shippingRequestedAt).toBeNull()
    } else {
      expect(shipment.status).toBe(ShippingStatus.CHECKING)
      expect(shipment.cancelledAt).toBeNull()
      expect(prize.status).toBe(PrizeStatus.SHIPPING_REQUESTED)
    }
  })

  it('同じ申請へ同時に 3 回取消しを投げても、成立するのは 1 回だけ', async () => {
    const { userId, addressId, prizeIds } = await setupUserWithPrizes('cancel-dup')
    const prizeId = prizeIds[0]
    if (!prizeId) throw new Error('当選商品がありません')

    const { shippingRequestId } = await requestShippingOnce(userId, [prizeId], addressId)

    const cancel = () =>
      testPrisma.$transaction((tx) =>
        cancelShippingRequest(tx, {
          actorId: userId,
          actorType: 'USER',
          shippingRequestId,
          reason: '住所を間違えたため',
        }),
      )

    const results = await Promise.allSettled([cancel(), cancel(), cancel()])

    const succeeded = results.filter((result) => result.status === 'fulfilled')
    expect(succeeded).toHaveLength(1)

    // 商品が二重に戻されていない（明細の取消しも 1 回だけ）
    const cancelledItems = await testPrisma.shippingRequestItem.count({
      where: { shippingRequestId, cancelledAt: { not: null } },
    })
    expect(cancelledItems).toBe(1)
  })

  it('同じ申請へ同時に 2 回発送済みを投げても、在庫は二重に進まない', async () => {
    const { userId, adminId, addressId, prizeIds } = await setupUserWithPrizes('shipped-dup')
    const prizeId = prizeIds[0]
    if (!prizeId) throw new Error('当選商品がありません')

    const { shippingRequestId } = await requestShippingOnce(userId, [prizeId], addressId)

    for (const status of [ShippingStatus.CHECKING, ShippingStatus.PACKING]) {
      await testPrisma.$transaction((tx) =>
        updateShippingStatus(tx, { adminId, shippingRequestId, input: { status } }),
      )
    }

    const ship = () =>
      testPrisma.$transaction((tx) =>
        updateShippingStatus(tx, {
          adminId,
          shippingRequestId,
          input: {
            status: ShippingStatus.SHIPPED,
            carrier: 'ヤマト運輸',
            trackingNumber: '1234567890',
          },
        }),
      )

    const results = await Promise.allSettled([ship(), ship()])

    const succeeded = results.filter((result) => result.status === 'fulfilled')
    expect(succeeded).toHaveLength(1)

    const prize = await testPrisma.userPrize.findUniqueOrThrow({
      where: { id: prizeId },
      select: { status: true, inventoryId: true },
    })
    expect(prize.status).toBe(PrizeStatus.SHIPPED)

    const inventory = await testPrisma.inventory.findUniqueOrThrow({
      where: { id: prize.inventoryId ?? '' },
      select: { status: true },
    })
    expect(inventory.status).toBe(InventoryStatus.SHIPPED)
  })
})
