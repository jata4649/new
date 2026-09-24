import type { EffectTier, ShippingStatus } from '@/generated/prisma/enums.ts'
import { prisma } from '@/server/db.ts'

import type { AdminShipmentListQuery, ShipmentListQuery } from './schema.ts'

/**
 * 発送申請の参照。
 *
 * 【重要】利用者向けの関数はすべて userId を必須で受け取り、
 *   WHERE 句に必ず含める。「ID を知っていれば読める」構造にしない。
 *
 * 表示する宛先は申請時点のスナップショット。
 * 利用者が住所を編集・削除しても、過去の申請の宛先は変わらない。
 */

export interface ShipmentItemSummary {
  userPrizeId: string
  name: string
  effectTier: EffectTier
  imageKey: string | null
  cancelledAt: Date | null
}

export interface ShipmentSummary {
  id: string
  status: ShippingStatus
  recipientName: string
  postalCode: string
  prefecture: string
  city: string
  addressLine1: string
  addressLine2: string | null
  phoneNumber: string
  carrier: string | null
  trackingNumber: string | null
  shippedAt: Date | null
  deliveredAt: Date | null
  cancelledAt: Date | null
  cancelReason: string | null
  createdAt: Date
  items: ShipmentItemSummary[]
}

export interface ShipmentListResult {
  items: ShipmentSummary[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

const ITEM_SELECT = {
  userPrizeId: true,
  cancelledAt: true,
  userPrize: {
    select: { nameSnapshot: true, effectTier: true, imageKeySnapshot: true },
  },
} as const

const SUMMARY_SELECT = {
  id: true,
  status: true,
  recipientName: true,
  postalCode: true,
  prefecture: true,
  city: true,
  addressLine1: true,
  addressLine2: true,
  phoneNumber: true,
  carrier: true,
  trackingNumber: true,
  shippedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  items: { select: ITEM_SELECT, orderBy: { createdAt: 'asc' } },
} as const

type RawShipment = {
  items: {
    userPrizeId: string
    cancelledAt: Date | null
    userPrize: {
      nameSnapshot: string
      effectTier: EffectTier
      imageKeySnapshot: string | null
    }
  }[]
} & Omit<ShipmentSummary, 'items'>

function toSummary(row: RawShipment): ShipmentSummary {
  return {
    ...row,
    items: row.items.map((item) => ({
      userPrizeId: item.userPrizeId,
      name: item.userPrize.nameSnapshot,
      effectTier: item.userPrize.effectTier,
      imageKey: item.userPrize.imageKeySnapshot,
      cancelledAt: item.cancelledAt,
    })),
  }
}

export async function listUserShipments(
  userId: string,
  query: ShipmentListQuery,
): Promise<ShipmentListResult> {
  const where = { userId, ...(query.status ? { status: query.status } : {}) }

  const [total, rows] = await Promise.all([
    prisma.shippingRequest.count({ where }),
    prisma.shippingRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
      select: SUMMARY_SELECT,
    }),
  ])

  return {
    items: rows.map(toSummary),
    total,
    page: query.page,
    perPage: query.perPage,
    totalPages: Math.max(1, Math.ceil(total / query.perPage)),
  }
}

export async function getUserShipment(
  userId: string,
  shipmentId: string,
): Promise<ShipmentSummary | null> {
  const row = await prisma.shippingRequest.findFirst({
    where: { id: shipmentId, userId },
    select: SUMMARY_SELECT,
  })
  return row ? toSummary(row) : null
}

/* -------------------------------------------------------------------------- */

export interface AdminShipmentSummary extends ShipmentSummary {
  userId: string
  userEmail: string
  userDisplayName: string
  adminNote: string | null
}

export interface AdminShipmentListResult {
  items: AdminShipmentSummary[]
  total: number
  page: number
  perPage: number
  totalPages: number
  /** 未処理（REQUESTED / CHECKING / PACKING）の総数。絞り込みに関わらず全体。 */
  pendingTotal: number
}

const ADMIN_SELECT = {
  ...SUMMARY_SELECT,
  userId: true,
  adminNote: true,
  user: { select: { email: true, profile: { select: { displayName: true } } } },
} as const

const PENDING_STATUSES = ['REQUESTED', 'CHECKING', 'PACKING'] as const

/**
 * 発送申請一覧（管理画面）。
 *
 * 未処理を数える対象は「絞り込みに関わらず全体」。
 * 絞り込んだ状態でも「あと何件残っているか」が常に見えるようにする。
 */
export async function listShipmentsForAdmin(
  query: AdminShipmentListQuery,
): Promise<AdminShipmentListResult> {
  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.userEmail
      ? { user: { email: { contains: query.userEmail.toLowerCase() } } }
      : {}),
  }

  const [total, pendingTotal, rows] = await Promise.all([
    prisma.shippingRequest.count({ where }),
    prisma.shippingRequest.count({ where: { status: { in: [...PENDING_STATUSES] } } }),
    prisma.shippingRequest.findMany({
      where,
      // 古い申請から処理する。待たせている順に並べるのが運用上も正しい。
      orderBy: { createdAt: 'asc' },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
      select: ADMIN_SELECT,
    }),
  ])

  return {
    items: rows.map((row) => ({
      ...toSummary(row),
      userId: row.userId,
      userEmail: row.user.email,
      userDisplayName: row.user.profile?.displayName ?? row.user.email,
      adminNote: row.adminNote,
    })),
    total,
    pendingTotal,
    page: query.page,
    perPage: query.perPage,
    totalPages: Math.max(1, Math.ceil(total / query.perPage)),
  }
}

export async function getShipmentForAdmin(
  shipmentId: string,
): Promise<AdminShipmentSummary | null> {
  const row = await prisma.shippingRequest.findUnique({
    where: { id: shipmentId },
    select: ADMIN_SELECT,
  })
  if (!row) return null

  return {
    ...toSummary(row),
    userId: row.userId,
    userEmail: row.user.email,
    userDisplayName: row.user.profile?.displayName ?? row.user.email,
    adminNote: row.adminNote,
  }
}
