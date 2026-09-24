import { Prisma } from '@/generated/prisma/client.ts'
import { InventoryStatus, type CardCondition } from '@/generated/prisma/enums.ts'
import { AppError, ERROR_CODES, errors } from '@/lib/api/errors.ts'
import { now } from '@/lib/datetime/index.ts'
import { AUDIT_ACTIONS, AUDIT_TARGETS, writeAuditLog } from '@/modules/audit/service.ts'
import { prisma, type PrismaTransactionClient } from '@/server/db.ts'

import type {
  CreateInventoryInput,
  InventoryListQuery,
  UpdateInventoryInput,
} from './schema.ts'

/**
 * カード在庫の管理。
 *
 * 在庫は物理個体ごとに 1 行。
 * 「同じ物理在庫を複数の販売中オリパへ重複割当できない」は
 * oripa_slots.inventory_id のグローバル UNIQUE で保証している（INV-5）。
 */

/** 状態の手動変更で理由の入力を必須にするもの */
const REASON_REQUIRED_STATUSES: readonly InventoryStatus[] = [
  InventoryStatus.DAMAGED,
  InventoryStatus.LOST,
]

/**
 * 管理者が手で設定してよい状態。
 * WON / SHIPPING_REQUESTED / SHIPPED / EXCHANGED は
 * 抽選・発送・交換の処理が設定するものなので、手動変更を許さない。
 */
const MANUALLY_SETTABLE_STATUSES: readonly InventoryStatus[] = [
  InventoryStatus.AVAILABLE,
  InventoryStatus.DAMAGED,
  InventoryStatus.LOST,
]

export interface InventoryListItem {
  id: string
  code: string
  cardTitle: string
  cardName: string
  rarity: string | null
  condition: CardCondition
  exchangePoints: number
  referencePriceYen: number | null
  status: InventoryStatus
  /** 割当先のオリパ（未割当なら null） */
  allocatedCampaign: { id: string; name: string; slug: string } | null
  createdAt: Date
}

export interface InventoryListResult {
  items: InventoryListItem[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export async function listInventories(query: InventoryListQuery): Promise<InventoryListResult> {
  const where = {
    deletedAt: null,
    ...(query.status ? { status: query.status } : {}),
    ...(query.rarity ? { rarity: query.rarity } : {}),
    ...(query.q
      ? {
          OR: [
            { code: { contains: query.q, mode: 'insensitive' as const } },
            { cardName: { contains: query.q, mode: 'insensitive' as const } },
            { cardTitle: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  }

  const [total, items] = await Promise.all([
    prisma.inventory.count({ where }),
    prisma.inventory.findMany({
      where,
      select: {
        id: true,
        code: true,
        cardTitle: true,
        cardName: true,
        rarity: true,
        condition: true,
        exchangePoints: true,
        referencePriceYen: true,
        status: true,
        createdAt: true,
        slot: {
          select: {
            campaign: { select: { id: true, name: true, slug: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    }),
  ])

  return {
    items: items.map((item) => ({
      id: item.id,
      code: item.code,
      cardTitle: item.cardTitle,
      cardName: item.cardName,
      rarity: item.rarity,
      condition: item.condition,
      exchangePoints: item.exchangePoints,
      referencePriceYen: item.referencePriceYen,
      status: item.status,
      allocatedCampaign: item.slot?.campaign ?? null,
      createdAt: item.createdAt,
    })),
    total,
    page: query.page,
    perPage: query.perPage,
    totalPages: Math.max(1, Math.ceil(total / query.perPage)),
  }
}

export interface InventoryDetail extends InventoryListItem {
  cardNumber: string | null
  gradingCompany: string | null
  gradingScore: string | null
  gradingCertNo: string | null
  costPriceYen: number | null
  storageLocation: string | null
  frontImageKey: string | null
  backImageKey: string | null
  note: string | null
  acquisitionSource: string | null
  acquiredFrom: string | null
  acquiredAt: Date | null
}

export async function getInventoryForAdmin(inventoryId: string): Promise<InventoryDetail> {
  const item = await prisma.inventory.findFirst({
    where: { id: inventoryId, deletedAt: null },
    select: {
      id: true,
      code: true,
      cardTitle: true,
      cardName: true,
      cardNumber: true,
      rarity: true,
      condition: true,
      gradingCompany: true,
      gradingScore: true,
      gradingCertNo: true,
      costPriceYen: true,
      referencePriceYen: true,
      exchangePoints: true,
      storageLocation: true,
      frontImageKey: true,
      backImageKey: true,
      note: true,
      acquisitionSource: true,
      acquiredFrom: true,
      acquiredAt: true,
      status: true,
      createdAt: true,
      slot: { select: { campaign: { select: { id: true, name: true, slug: true } } } },
    },
  })

  if (!item) {
    throw errors.notFound('在庫')
  }

  const { slot, ...rest } = item
  return { ...rest, allocatedCampaign: slot?.campaign ?? null }
}

export async function createInventory(
  tx: PrismaTransactionClient,
  input: CreateInventoryInput,
  actor: { id: string },
  context: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<{ id: string; code: string }> {
  try {
    const created = await tx.inventory.create({
      data: {
        code: input.code,
        cardTitle: input.cardTitle,
        cardName: input.cardName,
        cardNumber: input.cardNumber ?? null,
        rarity: input.rarity ?? null,
        condition: input.condition,
        gradingCompany: input.gradingCompany ?? null,
        gradingScore: input.gradingScore ?? null,
        gradingCertNo: input.gradingCertNo ?? null,
        costPriceYen: input.costPriceYen ?? null,
        referencePriceYen: input.referencePriceYen ?? null,
        exchangePoints: input.exchangePoints,
        storageLocation: input.storageLocation ?? null,
        frontImageKey: input.frontImageKey ?? null,
        backImageKey: input.backImageKey ?? null,
        note: input.note ?? null,
        acquisitionSource: input.acquisitionSource ?? null,
        acquiredFrom: input.acquiredFrom ?? null,
        acquiredAt: input.acquiredAt ? new Date(input.acquiredAt) : null,
      },
      select: { id: true, code: true },
    })

    await writeAuditLog(
      {
        actorType: 'ADMIN',
        actorId: actor.id,
        action: AUDIT_ACTIONS.INVENTORY_CREATE,
        targetType: AUDIT_TARGETS.INVENTORY,
        targetId: created.id,
        after: { code: created.code, cardName: input.cardName },
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      },
      tx,
    )

    return created
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(ERROR_CODES.CONFLICT, 409, 'この在庫コードはすでに使われています', {
        meta: { code: input.code },
      })
    }
    throw error
  }
}

export async function updateInventory(
  tx: PrismaTransactionClient,
  inventoryId: string,
  input: UpdateInventoryInput,
  actor: { id: string },
  context: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<{ id: string }> {
  const existing = await tx.inventory.findFirst({
    where: { id: inventoryId, deletedAt: null },
    select: {
      id: true,
      status: true,
      exchangePoints: true,
      slot: { select: { campaign: { select: { publishedAt: true, name: true } } } },
    },
  })

  if (!existing) {
    throw errors.notFound('在庫')
  }

  // 公開済みオリパへ割り当て済みの在庫は、交換ポイントを変えられない。
  // スロットにはスナップショットが入っているので抽選結果には影響しないが、
  // 表示と実際の値がずれると混乱を招くため。
  const isAllocatedToPublished = existing.slot?.campaign.publishedAt != null
  if (isAllocatedToPublished && input.exchangePoints !== undefined) {
    throw errors.conflict(
      '公開済みオリパへ割り当て済みの在庫は、交換ポイントを変更できません',
      { inventoryId, campaign: existing.slot?.campaign.name },
    )
  }

  if (input.status !== undefined && input.status !== existing.status) {
    if (!MANUALLY_SETTABLE_STATUSES.includes(input.status)) {
      throw errors.conflict(
        'この状態は抽選・発送・交換の処理が設定するため、手動では変更できません',
        { from: existing.status, to: input.status },
      )
    }
    if (
      REASON_REQUIRED_STATUSES.includes(input.status) &&
      (input.reason?.trim().length ?? 0) < 5
    ) {
      throw errors.reasonRequired()
    }
    if (isAllocatedToPublished) {
      throw errors.conflict('公開済みオリパへ割り当て済みの在庫は状態を変更できません', {
        inventoryId,
      })
    }
  }

  const { reason, status, acquiredAt, ...rest } = input

  const updated = await tx.inventory.update({
    where: { id: inventoryId },
    data: {
      ...rest,
      ...(status !== undefined ? { status } : {}),
      ...(acquiredAt !== undefined ? { acquiredAt: new Date(acquiredAt) } : {}),
      ...(reason !== undefined ? { note: reason } : {}),
    },
    select: { id: true },
  })

  await writeAuditLog(
    {
      actorType: 'ADMIN',
      actorId: actor.id,
      action: AUDIT_ACTIONS.INVENTORY_UPDATE,
      targetType: AUDIT_TARGETS.INVENTORY,
      targetId: inventoryId,
      reason: reason ?? null,
      before: { status: existing.status, exchangePoints: existing.exchangePoints },
      after: { status: status ?? existing.status, ...rest },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    },
    tx,
  )

  return updated
}

export interface AvailableInventory {
  id: string
  code: string
  cardTitle: string
  cardName: string
  rarity: string | null
  exchangePoints: number
  referencePriceYen: number | null
  frontImageKey: string | null
}

/**
 * まだどのオリパにも割り当てられていない在庫を取得する。
 * 景品割当の候補として使う。
 */
export async function listAllocatableInventories(
  tx: PrismaTransactionClient,
  options: { rarity?: string; limit?: number } = {},
): Promise<AvailableInventory[]> {
  return tx.inventory.findMany({
    where: {
      deletedAt: null,
      status: InventoryStatus.AVAILABLE,
      // スロットへ未割当のものだけ
      slot: { is: null },
      ...(options.rarity ? { rarity: options.rarity } : {}),
    },
    select: {
      id: true,
      code: true,
      cardTitle: true,
      cardName: true,
      rarity: true,
      exchangePoints: true,
      referencePriceYen: true,
      frontImageKey: true,
    },
    orderBy: [{ referencePriceYen: 'desc' }, { id: 'asc' }],
    take: options.limit ?? 500,
  })
}

/**
 * 割当候補の在庫を取得する（管理画面の景品割当フォーム用）。
 * トランザクションを開かず、読み取りのみを行う。
 */
export async function listAllocatableInventoriesForAdmin(
  options: { rarity?: string; limit?: number } = {},
): Promise<AvailableInventory[]> {
  return listAllocatableInventories(prisma, options)
}

/** 在庫を割当済みにする（スロット生成時に呼ぶ） */
export async function markAllocated(
  tx: PrismaTransactionClient,
  inventoryIds: readonly string[],
): Promise<number> {
  if (inventoryIds.length === 0) return 0

  const result = await tx.inventory.updateMany({
    where: { id: { in: [...inventoryIds] }, status: InventoryStatus.AVAILABLE },
    data: { status: InventoryStatus.ALLOCATED },
  })

  if (result.count !== inventoryIds.length) {
    // 誰かが同時に別のオリパへ割り当てた可能性がある
    throw errors.inventoryAlreadyAllocated(inventoryIds.slice(0, 5).join(', '))
  }

  return result.count
}

/** 割当を解除する（下書きのスロットを作り直すときに呼ぶ） */
export async function releaseAllocation(
  tx: PrismaTransactionClient,
  inventoryIds: readonly string[],
): Promise<number> {
  if (inventoryIds.length === 0) return 0

  const result = await tx.inventory.updateMany({
    where: { id: { in: [...inventoryIds] }, status: InventoryStatus.ALLOCATED },
    data: { status: InventoryStatus.AVAILABLE },
  })
  return result.count
}

/** 古物台帳としてのエクスポート（本番化前チェックリストの項目） */
export async function exportAcquisitionLedger(options: { from?: Date; to?: Date } = {}) {
  return prisma.inventory.findMany({
    where: {
      deletedAt: null,
      ...(options.from || options.to
        ? {
            acquiredAt: {
              ...(options.from ? { gte: options.from } : {}),
              ...(options.to ? { lte: options.to } : {}),
            },
          }
        : {}),
    },
    select: {
      code: true,
      cardTitle: true,
      cardName: true,
      condition: true,
      costPriceYen: true,
      acquisitionSource: true,
      acquiredFrom: true,
      acquiredAt: true,
      status: true,
    },
    orderBy: { acquiredAt: 'asc' },
  })
}

/** 現在時刻を使う処理のためのヘルパー（テストから時刻を固定できる） */
export function currentTimestamp(): Date {
  return now()
}
