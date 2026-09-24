import { InventoryStatus, PrizeStatus, ShippingStatus } from '@/generated/prisma/enums.ts'
import { errors } from '@/lib/api/errors.ts'
import { now } from '@/lib/datetime/index.ts'
import { AUDIT_ACTIONS, AUDIT_TARGETS, writeAuditLog } from '@/modules/audit/service.ts'
import type { PrismaTransactionClient } from '@/server/db.ts'

import { lockPrizesForShipping, lockShippingRequestForUpdate } from './repository.ts'
import type { UpdateShippingStatusInput } from './schema.ts'

/**
 * 発送申請。
 *
 * ■ 単一トランザクションであることが安全装置
 *   申請の作成・明細の作成・当選商品の遷移・在庫の遷移がすべて同じ
 *   トランザクションにある。途中でどれか 1 つでも失敗すれば（0 件更新を含む）
 *   すべて巻き戻り、「申請はあるのに商品が未選択のまま」は生まれない。
 *
 * ■ 二重申請を防ぐ 3 つの層
 *   1. 行ロック（FOR UPDATE、ID 昇順）＋ ロック後の状態再確認
 *   2. 条件付き UPDATE（status = 'UNDECIDED' のときだけ遷移）＋ 件数検査
 *   3. shipping_request_items の部分 UNIQUE（cancelled_at IS NULL）= INV-7
 *      → 同じ当選商品が同時に 2 件の有効な申請へ入らないことを DB が保証する
 *
 *   3 層目だけでも壊れたデータは防げるが、利用者へ返るのが 500 になる。
 *   1 層目のロックがあるおかげで「すでに申請済みです（409）」と伝えられる。
 *
 * ■ ポイント交換との関係
 *   どちらも UNDECIDED からの遷移。先に片方が成立すれば、
 *   もう片方は条件付き UPDATE が 0 件になって弾かれる。
 *   交換は取消不可だが、発送申請は発送準備前なら取り消して UNDECIDED へ戻せる。
 *
 * ■ 住所はスナップショットで持つ
 *   申請後に利用者が住所を編集・削除しても、その申請の宛先は変わらない。
 *   「どこへ送ったか」は記録であって、参照であってはならない。
 */

export interface RequestShippingParams {
  userId: string
  prizeIds: string[]
  addressId: string
  idempotencyKeyId: string
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

export interface RequestShippingResult {
  shippingRequestId: string
  itemCount: number
  status: ShippingStatus
  recipientName: string
}

export async function requestShipping(
  tx: PrismaTransactionClient,
  params: RequestShippingParams,
): Promise<RequestShippingResult> {
  const { userId, prizeIds, addressId } = params

  // --- 1. 配送先を確定する（自分のものだけ） ---
  const address = await tx.address.findFirst({
    where: { id: addressId, userId, deletedAt: null },
    select: {
      id: true,
      recipientName: true,
      postalCode: true,
      prefecture: true,
      city: true,
      addressLine1: true,
      addressLine2: true,
      phoneNumber: true,
    },
  })
  if (!address) {
    throw errors.notFound('配送先')
  }

  // --- 2. 対象の当選商品を行ロックして読む（ID 昇順・デッドロック回避） ---
  const prizes = await lockPrizesForShipping(tx, prizeIds, userId)

  // 他人の商品・存在しない ID は「見つからない」として扱う
  if (prizes.length !== prizeIds.length) {
    throw errors.notFound('当選商品')
  }

  for (const prize of prizes) {
    if (prize.status === PrizeStatus.SHIPPING_REQUESTED) {
      throw errors.prizeAlreadyRequested()
    }
    if (prize.status !== PrizeStatus.UNDECIDED) {
      throw errors.prizeNotUndecided()
    }
    if (!prize.shippable) {
      throw errors.prizeNotShippable(prize.name_snapshot)
    }
  }

  const at = now()

  // --- 3. 申請を作る（住所はスナップショット） ---
  const request = await tx.shippingRequest.create({
    data: {
      userId,
      status: ShippingStatus.REQUESTED,
      addressId: address.id,
      recipientName: address.recipientName,
      postalCode: address.postalCode,
      prefecture: address.prefecture,
      city: address.city,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2,
      phoneNumber: address.phoneNumber,
      idempotencyKeyId: params.idempotencyKeyId,
      items: {
        create: prizes.map((prize) => ({ userPrizeId: prize.id })),
      },
    },
    select: { id: true },
  })

  // --- 4. 当選商品を申請中にする（条件付き UPDATE + 件数検査） ---
  const updated = await tx.userPrize.updateMany({
    where: {
      id: { in: prizes.map((prize) => prize.id) },
      userId,
      status: PrizeStatus.UNDECIDED,
    },
    data: { status: PrizeStatus.SHIPPING_REQUESTED, shippingRequestedAt: at },
  })
  if (updated.count !== prizes.length) {
    // 先に別のリクエストが交換または申請した。
    // ここで投げればトランザクションごと巻き戻り、申請は残らない。
    throw errors.prizeNotUndecided()
  }

  // --- 5. 物理在庫を申請中にする ---
  const inventoryIds = prizes
    .map((prize) => prize.inventory_id)
    .filter((id): id is string => id !== null)

  if (inventoryIds.length > 0) {
    const inventoryUpdated = await tx.inventory.updateMany({
      where: { id: { in: inventoryIds }, status: InventoryStatus.WON },
      data: { status: InventoryStatus.SHIPPING_REQUESTED },
    })
    if (inventoryUpdated.count !== inventoryIds.length) {
      throw errors.conflict('在庫の状態が変化しています', { shippingRequestId: request.id })
    }
  }

  await writeAuditLog(
    {
      actorType: 'USER',
      actorId: userId,
      action: AUDIT_ACTIONS.SHIPPING_REQUESTED,
      targetType: AUDIT_TARGETS.SHIPPING_REQUEST,
      targetId: request.id,
      after: { itemCount: prizes.length, status: ShippingStatus.REQUESTED },
      ip: params.ip,
      userAgent: params.userAgent,
      requestId: params.requestId,
    },
    tx,
  )

  return {
    shippingRequestId: request.id,
    itemCount: prizes.length,
    status: ShippingStatus.REQUESTED,
    recipientName: address.recipientName,
  }
}

/* -------------------------------------------------------------------------- */

/** 取消しできる状態。発送準備（PACKING）に入ったら止められない。 */
const CANCELLABLE_BY_USER: ShippingStatus[] = [ShippingStatus.REQUESTED]

/** 管理者は梱包中まで取り消せる（在庫の欠品・破損が判明することがある） */
const CANCELLABLE_BY_ADMIN: ShippingStatus[] = [
  ShippingStatus.REQUESTED,
  ShippingStatus.CHECKING,
  ShippingStatus.PACKING,
]

export interface CancelShippingParams {
  /** 利用者本人による取消しなら userId、管理者ならその ID */
  actorId: string
  actorType: 'USER' | 'ADMIN'
  shippingRequestId: string
  reason: string
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

export interface CancelShippingResult {
  shippingRequestId: string
  restoredPrizeCount: number
}

/**
 * 発送申請の取消し。
 *
 * 当選商品を UNDECIDED へ戻すので、利用者は改めて交換か再申請を選べる。
 * 明細行は物理削除せず cancelled_at を立てる。
 * 「いつ申請していつ取り消したか」は残す必要があり、
 * 部分 UNIQUE（cancelled_at IS NULL）は取消し済みを数えないため、
 * 同じ商品で再申請しても衝突しない。
 */
export async function cancelShippingRequest(
  tx: PrismaTransactionClient,
  params: CancelShippingParams,
): Promise<CancelShippingResult> {
  const { actorId, actorType, shippingRequestId, reason } = params

  const locked = await lockShippingRequestForUpdate(tx, shippingRequestId)
  if (!locked) {
    throw errors.notFound('発送申請')
  }

  // 利用者は自分の申請しか触れない。他人のものは「存在しない」として扱う。
  if (actorType === 'USER' && locked.user_id !== actorId) {
    throw errors.notFound('発送申請')
  }

  const allowed = actorType === 'ADMIN' ? CANCELLABLE_BY_ADMIN : CANCELLABLE_BY_USER
  if (!allowed.includes(locked.status as ShippingStatus)) {
    throw errors.shippingNotCancellable(locked.status)
  }

  const at = now()

  // 条件付き UPDATE。同時に管理者が発送済みにしていたら 0 件になる。
  const cancelled = await tx.shippingRequest.updateMany({
    where: { id: locked.id, status: { in: allowed } },
    data: { status: ShippingStatus.CANCELLED, cancelledAt: at, cancelReason: reason },
  })
  if (cancelled.count !== 1) {
    throw errors.shippingNotCancellable(locked.status)
  }

  // 有効な明細だけを取消しにする（すでに取消し済みは触らない）
  const items = await tx.shippingRequestItem.findMany({
    where: { shippingRequestId: locked.id, cancelledAt: null },
    select: { id: true, userPrizeId: true },
  })

  await tx.shippingRequestItem.updateMany({
    where: { id: { in: items.map((item) => item.id) } },
    data: { cancelledAt: at },
  })

  const prizeIds = items.map((item) => item.userPrizeId)

  // 当選商品を未選択へ戻す
  const restored = await tx.userPrize.updateMany({
    where: { id: { in: prizeIds }, status: PrizeStatus.SHIPPING_REQUESTED },
    data: { status: PrizeStatus.UNDECIDED, shippingRequestedAt: null },
  })
  if (restored.count !== prizeIds.length) {
    throw errors.conflict('当選商品の状態が変化しています', { shippingRequestId: locked.id })
  }

  // 物理在庫も当選済みへ戻す
  const prizes = await tx.userPrize.findMany({
    where: { id: { in: prizeIds }, inventoryId: { not: null } },
    select: { inventoryId: true },
  })
  const inventoryIds = prizes
    .map((prize) => prize.inventoryId)
    .filter((id): id is string => id !== null)

  if (inventoryIds.length > 0) {
    await tx.inventory.updateMany({
      where: { id: { in: inventoryIds }, status: InventoryStatus.SHIPPING_REQUESTED },
      data: { status: InventoryStatus.WON },
    })
  }

  await writeAuditLog(
    {
      actorType,
      actorId,
      action: AUDIT_ACTIONS.SHIPPING_CANCEL,
      targetType: AUDIT_TARGETS.SHIPPING_REQUEST,
      targetId: locked.id,
      reason,
      before: { status: locked.status },
      after: { status: ShippingStatus.CANCELLED, restoredPrizeCount: prizeIds.length },
      ip: params.ip,
      userAgent: params.userAgent,
      requestId: params.requestId,
    },
    tx,
  )

  return { shippingRequestId: locked.id, restoredPrizeCount: prizeIds.length }
}

/* -------------------------------------------------------------------------- */

/**
 * 許可する状態遷移。
 *
 * 表で持つことで「PACKING から REQUESTED へ戻す」のような
 * 実務と合わない巻き戻りを構造的に作れなくする。
 * 取消しは別経路（cancelShippingRequest）で扱う。
 */
const ALLOWED_TRANSITIONS: Record<string, ShippingStatus[]> = {
  [ShippingStatus.REQUESTED]: [ShippingStatus.CHECKING],
  [ShippingStatus.CHECKING]: [ShippingStatus.PACKING],
  [ShippingStatus.PACKING]: [ShippingStatus.SHIPPED],
  [ShippingStatus.SHIPPED]: [ShippingStatus.DELIVERED],
  [ShippingStatus.DELIVERED]: [],
  [ShippingStatus.CANCELLED]: [],
}

export interface UpdateShippingStatusParams {
  adminId: string
  shippingRequestId: string
  input: UpdateShippingStatusInput
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

export interface UpdateShippingStatusResult {
  shippingRequestId: string
  status: ShippingStatus
}

/**
 * 管理者による発送状態の更新。
 *
 * SHIPPED へ進めたときに当選商品と在庫も SHIPPED にする。
 * ここで初めて「手元から出た」ことが確定するため、
 * それより前の段階では在庫を SHIPPING_REQUESTED のままにしておく
 * （取消しで戻せる状態を保つ）。
 */
export async function updateShippingStatus(
  tx: PrismaTransactionClient,
  params: UpdateShippingStatusParams,
): Promise<UpdateShippingStatusResult> {
  const { adminId, shippingRequestId, input } = params

  const locked = await lockShippingRequestForUpdate(tx, shippingRequestId)
  if (!locked) {
    throw errors.notFound('発送申請')
  }

  const allowed = ALLOWED_TRANSITIONS[locked.status] ?? []
  if (!allowed.includes(input.status)) {
    throw errors.shippingTransitionNotAllowed(locked.status, input.status)
  }

  const at = now()
  const isShipped = input.status === ShippingStatus.SHIPPED
  const isDelivered = input.status === ShippingStatus.DELIVERED

  const updated = await tx.shippingRequest.updateMany({
    where: { id: locked.id, status: locked.status as ShippingStatus },
    data: {
      status: input.status,
      ...(input.carrier !== undefined ? { carrier: input.carrier } : {}),
      ...(input.trackingNumber !== undefined ? { trackingNumber: input.trackingNumber } : {}),
      ...(input.adminNote !== undefined ? { adminNote: input.adminNote } : {}),
      ...(isShipped ? { shippedAt: at } : {}),
      ...(isDelivered ? { deliveredAt: at } : {}),
    },
  })
  if (updated.count !== 1) {
    // 同時に取消しなどで状態が変わった
    throw errors.shippingTransitionNotAllowed(locked.status, input.status)
  }

  if (isShipped) {
    const items = await tx.shippingRequestItem.findMany({
      where: { shippingRequestId: locked.id, cancelledAt: null },
      select: { userPrizeId: true },
    })
    const prizeIds = items.map((item) => item.userPrizeId)

    const shipped = await tx.userPrize.updateMany({
      where: { id: { in: prizeIds }, status: PrizeStatus.SHIPPING_REQUESTED },
      data: { status: PrizeStatus.SHIPPED },
    })
    if (shipped.count !== prizeIds.length) {
      throw errors.conflict('当選商品の状態が変化しています', { shippingRequestId: locked.id })
    }

    const prizes = await tx.userPrize.findMany({
      where: { id: { in: prizeIds }, inventoryId: { not: null } },
      select: { inventoryId: true },
    })
    const inventoryIds = prizes
      .map((prize) => prize.inventoryId)
      .filter((id): id is string => id !== null)

    if (inventoryIds.length > 0) {
      await tx.inventory.updateMany({
        where: { id: { in: inventoryIds }, status: InventoryStatus.SHIPPING_REQUESTED },
        data: { status: InventoryStatus.SHIPPED },
      })
    }
  }

  await writeAuditLog(
    {
      actorType: 'ADMIN',
      actorId: adminId,
      action: AUDIT_ACTIONS.SHIPPING_STATUS_UPDATE,
      targetType: AUDIT_TARGETS.SHIPPING_REQUEST,
      targetId: locked.id,
      before: { status: locked.status },
      after: {
        status: input.status,
        carrier: input.carrier ?? null,
        trackingNumber: input.trackingNumber ?? null,
      },
      ip: params.ip,
      userAgent: params.userAgent,
      requestId: params.requestId,
    },
    tx,
  )

  return { shippingRequestId: locked.id, status: input.status }
}
