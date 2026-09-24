import { beforeEach, describe, expect, it } from 'vitest'

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
import { listAddresses } from '@/modules/addresses/queries.ts'
import { createAddress, deleteAddress, updateAddress } from '@/modules/addresses/service.ts'
import { executeDraw } from '@/modules/draws/service.ts'
import { createOripa, publishOripa } from '@/modules/oripa/service.ts'
import { generateSlots } from '@/modules/oripa/slots.ts'
import { grantPoints } from '@/modules/points/ledger.ts'
import { exchangePrize } from '@/modules/prizes/service.ts'
import { getUserShipment, listShipmentsForAdmin } from '@/modules/shipping/queries.ts'
import {
  cancelShippingRequest,
  requestShipping,
  updateShippingStatus,
} from '@/modules/shipping/service.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * 配送先・発送申請の統合テスト。
 *
 * 確認する不変条件:
 *  - 既定の配送先はユーザーごとに常に 1 件
 *  - 申請時の宛先はスナップショットで、住所を変えても変わらない
 *  - 1 つの当選商品が同時に 2 件の有効な申請へ入らない（INV-7）
 *  - 申請すると交換できず、取り消せば交換できる
 *  - 発送済みまで進むと当選商品も在庫も SHIPPED になる
 *  - 巻き戻しの遷移はできない
 *  - 他人の申請は読めず、取り消せない
 */

const DAY = 24 * 60 * 60 * 1000

let userId: string
let otherUserId: string
let adminId: string

const ADDRESS_INPUT = {
  recipientName: '架空 太郎',
  postalCode: '150-0001',
  prefecture: '東京都' as const,
  city: '渋谷区',
  addressLine1: '神南 1-2-3',
  addressLine2: null,
  phoneNumber: '09012345678',
  isDefault: false,
}

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
      sourceId: `shipping-test-${target}-${Math.random()}`,
      expiresAt: addDays(now(), 30),
    }),
  )
}

function addAddress(target: string, overrides: Partial<typeof ADDRESS_INPUT> = {}) {
  return testPrisma.$transaction((tx) =>
    createAddress(tx, { userId: target, input: { ...ADDRESS_INPUT, ...overrides } }),
  )
}

/**
 * 抽選で発送可能な当選商品を作る。
 *
 * 当選商品は抽選処理でしか生まれないので、テストでも同じ経路を通す。
 * 直接 INSERT すると、実際には作れないデータでテストしてしまう。
 *
 * 発送可能を確実にするため、物理在庫だけのオリパを使う
 * （汎用景品は shippable: false のことがある）。
 */
async function drawShippablePrizes(options: { user?: string; drawCount?: number } = {}) {
  const target = options.user ?? userId
  const drawCount = options.drawCount ?? 1
  const slug = 'shipping-test-oripa'

  const existing = await testPrisma.oripaCampaign.findUnique({ where: { slug } })
  if (!existing) {
    const inventories = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        testPrisma.inventory.create({
          data: {
            code: `SHIP-${String(index).padStart(4, '0')}`,
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
          name: '発送テスト用オリパ',
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
  }

  return testPrisma.$transaction(async (tx) => {
    const key = await tx.idempotencyKey.create({
      data: {
        userId: target,
        scope: 'draw',
        key: `shipping-draw-${Math.random()}`,
        requestHash: 'test',
        state: 'IN_PROGRESS',
        expiresAt: addDays(now(), 1),
      },
      select: { id: true },
    })
    return executeDraw(tx, { userId: target, slug, drawCount, idempotencyKeyId: key.id })
  })
}

async function newIdempotencyKey(target: string, scope: string): Promise<string> {
  const key = await testPrisma.idempotencyKey.create({
    data: {
      userId: target,
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

async function request(options: { user?: string; prizeIds: string[]; addressId: string }) {
  const target = options.user ?? userId
  const keyId = await newIdempotencyKey(target, 'shipping_request')
  return testPrisma.$transaction((tx) =>
    requestShipping(tx, {
      userId: target,
      prizeIds: options.prizeIds,
      addressId: options.addressId,
      idempotencyKeyId: keyId,
    }),
  )
}

beforeEach(async () => {
  adminId = await createUser('shipping-admin@example.test', 'ADMIN')
  userId = await createUser('shipping-user@example.test')
  otherUserId = await createUser('shipping-other@example.test')
  await giveFreePoints(userId, 10_000)
  await giveFreePoints(otherUserId, 10_000)
})

/* -------------------------------------------------------------------------- */

describe('配送先', () => {
  it('最初の 1 件は自動で既定になる', async () => {
    await addAddress(userId)
    const addresses = await listAddresses(userId)

    expect(addresses).toHaveLength(1)
    expect(addresses[0]?.isDefault).toBe(true)
  })

  it('既定を新しく立てると、前の既定は解除される', async () => {
    const first = await addAddress(userId)
    const second = await addAddress(userId, { recipientName: '架空 次郎', isDefault: true })

    const addresses = await listAddresses(userId)
    const byId = new Map(addresses.map((address) => [address.id, address]))

    expect(byId.get(second.id)?.isDefault).toBe(true)
    expect(byId.get(first.id)?.isDefault).toBe(false)
  })

  it('既定は常に高々 1 件（DB の部分 UNIQUE で保証）', async () => {
    await addAddress(userId)
    await addAddress(userId, { recipientName: '架空 次郎', isDefault: true })
    await addAddress(userId, { recipientName: '架空 三郎', isDefault: true })

    const defaults = await testPrisma.address.count({
      where: { userId, isDefault: true, deletedAt: null },
    })
    expect(defaults).toBe(1)
  })

  it('既定を自分で外すことはできない（既定なしの状態を作らない）', async () => {
    const created = await addAddress(userId)

    await expect(
      testPrisma.$transaction((tx) =>
        updateAddress(tx, { userId, addressId: created.id, input: { isDefault: false } }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR })
  })

  it('既定を削除すると、残りの 1 件が既定へ繰り上がる', async () => {
    const first = await addAddress(userId)
    await addAddress(userId, { recipientName: '架空 次郎' })

    await testPrisma.$transaction((tx) => deleteAddress(tx, { userId, addressId: first.id }))

    const addresses = await listAddresses(userId)
    expect(addresses).toHaveLength(1)
    expect(addresses[0]?.isDefault).toBe(true)
  })

  it('他人の配送先は更新も削除もできない', async () => {
    const created = await addAddress(otherUserId)

    await expect(
      testPrisma.$transaction((tx) =>
        updateAddress(tx, { userId, addressId: created.id, input: { city: '港区' } }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND })

    await expect(
      testPrisma.$transaction((tx) => deleteAddress(tx, { userId, addressId: created.id })),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND })
  })

  it('削除は論理削除で、一覧から消える', async () => {
    const created = await addAddress(userId)
    await testPrisma.$transaction((tx) => deleteAddress(tx, { userId, addressId: created.id }))

    expect(await listAddresses(userId)).toHaveLength(0)

    const row = await testPrisma.address.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.deletedAt).not.toBeNull()
  })
})

/* -------------------------------------------------------------------------- */

describe('発送申請', () => {
  it('申請すると当選商品と在庫が申請中になる', async () => {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    const result = await request({ prizeIds: [prize.userPrizeId], addressId: address.id })

    expect(result.itemCount).toBe(1)
    expect(result.status).toBe(ShippingStatus.REQUESTED)

    const stored = await testPrisma.userPrize.findUniqueOrThrow({
      where: { id: prize.userPrizeId },
      select: { status: true, shippingRequestedAt: true, inventoryId: true },
    })
    expect(stored.status).toBe(PrizeStatus.SHIPPING_REQUESTED)
    expect(stored.shippingRequestedAt).not.toBeNull()

    const inventory = await testPrisma.inventory.findUniqueOrThrow({
      where: { id: stored.inventoryId ?? '' },
      select: { status: true },
    })
    expect(inventory.status).toBe(InventoryStatus.SHIPPING_REQUESTED)
  })

  it('複数の商品を 1 件の申請へまとめられる', async () => {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes({ drawCount: 10 })

    const prizeIds = draw.prizes.map((prize) => prize.userPrizeId)
    const result = await request({ prizeIds, addressId: address.id })

    expect(result.itemCount).toBe(10)

    const shipment = await getUserShipment(userId, result.shippingRequestId)
    expect(shipment?.items).toHaveLength(10)
  })

  it('宛先は申請時点のスナップショット。住所を変えても申請は変わらない', async () => {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    const result = await request({ prizeIds: [prize.userPrizeId], addressId: address.id })

    await testPrisma.$transaction((tx) =>
      updateAddress(tx, {
        userId,
        addressId: address.id,
        input: { city: '港区', addressLine1: '六本木 9-9-9' },
      }),
    )

    const shipment = await getUserShipment(userId, result.shippingRequestId)
    expect(shipment?.city).toBe('渋谷区')
    expect(shipment?.addressLine1).toBe('神南 1-2-3')
  })

  it('配送先を削除しても、過去の申請の宛先は残る', async () => {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    const result = await request({ prizeIds: [prize.userPrizeId], addressId: address.id })
    await testPrisma.$transaction((tx) => deleteAddress(tx, { userId, addressId: address.id }))

    const shipment = await getUserShipment(userId, result.shippingRequestId)
    expect(shipment?.recipientName).toBe('架空 太郎')
  })

  it('申請済みの商品はポイント交換できない', async () => {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    await request({ prizeIds: [prize.userPrizeId], addressId: address.id })

    await expect(
      testPrisma.$transaction((tx) =>
        exchangePrize(tx, { userId, prizeId: prize.userPrizeId }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.PRIZE_NOT_UNDECIDED })
  })

  it('交換済みの商品は発送申請できない', async () => {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    await testPrisma.$transaction((tx) =>
      exchangePrize(tx, { userId, prizeId: prize.userPrizeId }),
    )

    await expect(
      request({ prizeIds: [prize.userPrizeId], addressId: address.id }),
    ).rejects.toMatchObject({ code: ERROR_CODES.PRIZE_NOT_UNDECIDED })
  })

  it('2 回目の申請は 409 になる（すでに申請中）', async () => {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    await request({ prizeIds: [prize.userPrizeId], addressId: address.id })

    await expect(
      request({ prizeIds: [prize.userPrizeId], addressId: address.id }),
    ).rejects.toMatchObject({ code: ERROR_CODES.PRIZE_ALREADY_REQUESTED })
  })

  it('他人の当選商品は申請できない', async () => {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes({ user: otherUserId })
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    await expect(
      request({ prizeIds: [prize.userPrizeId], addressId: address.id }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND })
  })

  it('他人の配送先へは申請できない', async () => {
    const otherAddress = await addAddress(otherUserId)
    const draw = await drawShippablePrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    await expect(
      request({ prizeIds: [prize.userPrizeId], addressId: otherAddress.id }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND })
  })

  it('発送できない商品（汎用景品）は申請できない', async () => {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')

    // 発送不可に変えてから申請する
    await testPrisma.userPrize.update({
      where: { id: prize.userPrizeId },
      data: { shippable: false },
    })

    await expect(
      request({ prizeIds: [prize.userPrizeId], addressId: address.id }),
    ).rejects.toMatchObject({ code: ERROR_CODES.PRIZE_NOT_SHIPPABLE })
  })

  it('1 件でも申請できない商品が混ざれば、申請ごと成立しない', async () => {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes({ drawCount: 10 })
    const prizeIds = draw.prizes.map((prize) => prize.userPrizeId)

    await testPrisma.userPrize.update({
      where: { id: prizeIds[0] ?? '' },
      data: { shippable: false },
    })

    await expect(request({ prizeIds, addressId: address.id })).rejects.toMatchObject({
      code: ERROR_CODES.PRIZE_NOT_SHIPPABLE,
    })

    // 巻き戻っているので、ほかの商品も未選択のまま
    const remaining = await testPrisma.userPrize.count({
      where: { id: { in: prizeIds }, status: PrizeStatus.UNDECIDED },
    })
    expect(remaining).toBe(prizeIds.length)

    const shipments = await testPrisma.shippingRequest.count({ where: { userId } })
    expect(shipments).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */

describe('発送申請の取消し', () => {
  async function requestOne() {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')
    const result = await request({ prizeIds: [prize.userPrizeId], addressId: address.id })
    return { prizeId: prize.userPrizeId, shipmentId: result.shippingRequestId }
  }

  function cancelAsUser(shipmentId: string, target = userId) {
    return testPrisma.$transaction((tx) =>
      cancelShippingRequest(tx, {
        actorId: target,
        actorType: 'USER',
        shippingRequestId: shipmentId,
        reason: '住所を間違えたため',
      }),
    )
  }

  it('取り消すと商品が未選択へ戻り、在庫も当選済みへ戻る', async () => {
    const { prizeId, shipmentId } = await requestOne()

    const result = await cancelAsUser(shipmentId)
    expect(result.restoredPrizeCount).toBe(1)

    const prize = await testPrisma.userPrize.findUniqueOrThrow({
      where: { id: prizeId },
      select: { status: true, shippingRequestedAt: true, inventoryId: true },
    })
    expect(prize.status).toBe(PrizeStatus.UNDECIDED)
    expect(prize.shippingRequestedAt).toBeNull()

    const inventory = await testPrisma.inventory.findUniqueOrThrow({
      where: { id: prize.inventoryId ?? '' },
      select: { status: true },
    })
    expect(inventory.status).toBe(InventoryStatus.WON)
  })

  it('取消し後は同じ商品で再申請できる（部分 UNIQUE は取消し済みを数えない）', async () => {
    const { prizeId, shipmentId } = await requestOne()
    await cancelAsUser(shipmentId)

    const addresses = await listAddresses(userId)
    const again = await request({ prizeIds: [prizeId], addressId: addresses[0]?.id ?? '' })

    expect(again.itemCount).toBe(1)
  })

  it('取消し後はポイント交換もできる', async () => {
    const { prizeId, shipmentId } = await requestOne()
    await cancelAsUser(shipmentId)

    const result = await testPrisma.$transaction((tx) => exchangePrize(tx, { userId, prizeId }))
    expect(result.grantedPoints).toBeGreaterThan(0)
  })

  it('取消しには理由が残る（監査可能性）', async () => {
    const { shipmentId } = await requestOne()
    await cancelAsUser(shipmentId)

    const stored = await testPrisma.shippingRequest.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { status: true, cancelledAt: true, cancelReason: true },
    })
    expect(stored.status).toBe(ShippingStatus.CANCELLED)
    expect(stored.cancelledAt).not.toBeNull()
    expect(stored.cancelReason).toBe('住所を間違えたため')
  })

  it('他人の申請は取り消せない', async () => {
    const { shipmentId } = await requestOne()

    await expect(cancelAsUser(shipmentId, otherUserId)).rejects.toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
    })
  })

  it('検品に入ったら利用者は取り消せない', async () => {
    const { shipmentId } = await requestOne()

    await testPrisma.$transaction((tx) =>
      updateShippingStatus(tx, {
        adminId,
        shippingRequestId: shipmentId,
        input: { status: ShippingStatus.CHECKING },
      }),
    )

    await expect(cancelAsUser(shipmentId)).rejects.toMatchObject({
      code: ERROR_CODES.SHIPPING_NOT_CANCELLABLE,
    })
  })

  it('管理者は梱包中まで取り消せる', async () => {
    const { shipmentId } = await requestOne()

    for (const status of [ShippingStatus.CHECKING, ShippingStatus.PACKING]) {
      await testPrisma.$transaction((tx) =>
        updateShippingStatus(tx, { adminId, shippingRequestId: shipmentId, input: { status } }),
      )
    }

    const result = await testPrisma.$transaction((tx) =>
      cancelShippingRequest(tx, {
        actorId: adminId,
        actorType: 'ADMIN',
        shippingRequestId: shipmentId,
        reason: '検品で破損を確認したため',
      }),
    )
    expect(result.restoredPrizeCount).toBe(1)
  })

  it('取消しは監査ログに残る', async () => {
    const { shipmentId } = await requestOne()
    await cancelAsUser(shipmentId)

    const log = await testPrisma.auditLog.findFirst({
      where: { action: 'SHIPPING_CANCEL', targetId: shipmentId },
      select: { reason: true, actorId: true, actorType: true },
    })
    expect(log?.reason).toBe('住所を間違えたため')
    expect(log?.actorId).toBe(userId)
    expect(log?.actorType).toBe('USER')
  })
})

/* -------------------------------------------------------------------------- */

describe('発送作業（管理者）', () => {
  async function requestOne() {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')
    const result = await request({ prizeIds: [prize.userPrizeId], addressId: address.id })
    return { prizeId: prize.userPrizeId, shipmentId: result.shippingRequestId }
  }

  function advance(
    shipmentId: string,
    input: Parameters<typeof updateShippingStatus>[1]['input'],
  ) {
    return testPrisma.$transaction((tx) =>
      updateShippingStatus(tx, { adminId, shippingRequestId: shipmentId, input }),
    )
  }

  it('申請受付 → 検品 → 梱包 → 発送済み → 配達完了 と進められる', async () => {
    const { shipmentId } = await requestOne()

    await advance(shipmentId, { status: ShippingStatus.CHECKING })
    await advance(shipmentId, { status: ShippingStatus.PACKING })
    await advance(shipmentId, {
      status: ShippingStatus.SHIPPED,
      carrier: 'ヤマト運輸',
      trackingNumber: '1234567890',
    })
    const result = await advance(shipmentId, { status: ShippingStatus.DELIVERED })

    expect(result.status).toBe(ShippingStatus.DELIVERED)

    const stored = await testPrisma.shippingRequest.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { shippedAt: true, deliveredAt: true, trackingNumber: true },
    })
    expect(stored.shippedAt).not.toBeNull()
    expect(stored.deliveredAt).not.toBeNull()
    expect(stored.trackingNumber).toBe('1234567890')
  })

  it('段階を飛ばせない', async () => {
    const { shipmentId } = await requestOne()

    await expect(
      advance(shipmentId, {
        status: ShippingStatus.SHIPPED,
        carrier: 'ヤマト運輸',
        trackingNumber: '1234567890',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SHIPPING_TRANSITION_NOT_ALLOWED })
  })

  it('巻き戻せない', async () => {
    const { shipmentId } = await requestOne()
    await advance(shipmentId, { status: ShippingStatus.CHECKING })

    await expect(
      advance(shipmentId, { status: ShippingStatus.CHECKING }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SHIPPING_TRANSITION_NOT_ALLOWED })
  })

  it('発送済みにすると当選商品と在庫も発送済みになる', async () => {
    const { prizeId, shipmentId } = await requestOne()

    await advance(shipmentId, { status: ShippingStatus.CHECKING })
    await advance(shipmentId, { status: ShippingStatus.PACKING })
    await advance(shipmentId, {
      status: ShippingStatus.SHIPPED,
      carrier: 'ヤマト運輸',
      trackingNumber: '1234567890',
    })

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

  it('発送済みの申請は取り消せない', async () => {
    const { shipmentId } = await requestOne()

    await advance(shipmentId, { status: ShippingStatus.CHECKING })
    await advance(shipmentId, { status: ShippingStatus.PACKING })
    await advance(shipmentId, {
      status: ShippingStatus.SHIPPED,
      carrier: 'ヤマト運輸',
      trackingNumber: '1234567890',
    })

    await expect(
      testPrisma.$transaction((tx) =>
        cancelShippingRequest(tx, {
          actorId: adminId,
          actorType: 'ADMIN',
          shippingRequestId: shipmentId,
          reason: '取り消したい',
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.SHIPPING_NOT_CANCELLABLE })
  })

  it('状態更新は監査ログに残る', async () => {
    const { shipmentId } = await requestOne()
    await advance(shipmentId, { status: ShippingStatus.CHECKING })

    const log = await testPrisma.auditLog.findFirst({
      where: { action: 'SHIPPING_STATUS_UPDATE', targetId: shipmentId },
      select: { actorId: true, actorType: true, after: true },
    })
    expect(log?.actorId).toBe(adminId)
    expect(log?.actorType).toBe('ADMIN')
    expect(log?.after).toMatchObject({ status: ShippingStatus.CHECKING })
  })

  it('管理画面では未処理の件数が絞り込みに関わらず分かる', async () => {
    await requestOne()

    const result = await listShipmentsForAdmin({
      page: 1,
      perPage: 20,
      status: ShippingStatus.DELIVERED,
    })

    expect(result.items).toHaveLength(0)
    expect(result.pendingTotal).toBeGreaterThan(0)
  })
})

/* -------------------------------------------------------------------------- */

describe('DB ガード', () => {
  it('理由なしで取消し状態にはできない', async () => {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')
    const result = await request({ prizeIds: [prize.userPrizeId], addressId: address.id })

    await expect(
      testPrisma.$executeRaw`
        UPDATE shipping_requests SET status = 'CANCELLED' WHERE id = ${result.shippingRequestId}
      `,
    ).rejects.toThrow(/shipping_requests_cancelled_consistency_check/)
  })

  it('追跡番号なしで発送済みにはできない', async () => {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')
    const result = await request({ prizeIds: [prize.userPrizeId], addressId: address.id })

    await expect(
      testPrisma.$executeRaw`
        UPDATE shipping_requests
        SET status = 'SHIPPED', shipped_at = now()
        WHERE id = ${result.shippingRequestId}
      `,
    ).rejects.toThrow(/shipping_requests_tracking_consistency_check/)
  })

  it('同じ商品を 2 件の有効な申請へ入れられない（INV-7）', async () => {
    const address = await addAddress(userId)
    const draw = await drawShippablePrizes()
    const prize = draw.prizes[0]
    if (!prize) throw new Error('当選商品がありません')
    const result = await request({ prizeIds: [prize.userPrizeId], addressId: address.id })

    const second = await testPrisma.shippingRequest.create({
      data: {
        userId,
        status: ShippingStatus.REQUESTED,
        recipientName: '架空 太郎',
        postalCode: '150-0001',
        prefecture: '東京都',
        city: '渋谷区',
        addressLine1: '神南 1-2-3',
        phoneNumber: '09012345678',
      },
      select: { id: true },
    })

    await expect(
      testPrisma.shippingRequestItem.create({
        data: { shippingRequestId: second.id, userPrizeId: prize.userPrizeId },
      }),
    ).rejects.toThrow()

    // 元の申請は無事
    const original = await getUserShipment(userId, result.shippingRequestId)
    expect(original?.items).toHaveLength(1)
  })
})
