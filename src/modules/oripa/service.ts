import { Prisma } from '@/generated/prisma/client.ts'
import { CampaignStatus, InventoryStatus } from '@/generated/prisma/enums.ts'
import { AppError, ERROR_CODES, errors, type FieldError } from '@/lib/api/errors.ts'
import { sha256Hex } from '@/lib/crypto/random.ts'
import { isAfter, now } from '@/lib/datetime/index.ts'
import { AUDIT_ACTIONS, AUDIT_TARGETS, writeAuditLog } from '@/modules/audit/service.ts'
import { releaseAllocation } from '@/modules/inventory/service.ts'
import { prisma, type PrismaTransactionClient } from '@/server/db.ts'

import type { CreateOripaInput, OripaListQuery, UpdateOripaInput } from './schema.ts'
import { buildCommitment, generateSlots, verifySlotOrderCommitment } from './slots.ts'

/**
 * オリパ（キャンペーン）の管理。
 *
 * ■ 状態遷移
 *   DRAFT → SCHEDULED / ACTIVE → SUSPENDED / SOLD_OUT / ENDED → ARCHIVED
 *
 * ■ 公開後の不変性
 *   価格・総口数・景品スロット・当選確率は公開後に変更できない。
 *   アプリ層で拒否し、DB トリガでも拒否する
 *   （migrations/20260922000003_commit_reveal）。
 */

export interface CreateOripaResult {
  id: string
  slug: string
}

export async function createOripa(
  tx: PrismaTransactionClient,
  input: CreateOripaInput,
  actor: { id: string },
  context: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<CreateOripaResult> {
  try {
    const created = await tx.oripaCampaign.create({
      data: {
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        thumbnailKey: input.thumbnailKey ?? null,
        pricePoints: input.pricePoints,
        totalSlots: input.totalSlots,
        // 公開前は 1 口も売れていないので、残り口数は総口数と同じ
        remainingSlots: input.totalSlots,
        perUserLimit: input.perUserLimit ?? null,
        salesStartAt: new Date(input.salesStartAt),
        salesEndAt: new Date(input.salesEndAt),
        effectSetKey: input.effectSetKey,
        status: CampaignStatus.DRAFT,
        tiers: {
          create: input.tiers.map((tier) => ({
            code: tier.code,
            name: tier.name,
            effectTier: tier.effectTier,
            slotCount: tier.slotCount,
            displayOrder: tier.displayOrder,
          })),
        },
      },
      select: { id: true, slug: true },
    })

    await writeAuditLog(
      {
        actorType: 'ADMIN',
        actorId: actor.id,
        action: AUDIT_ACTIONS.ORIPA_CREATE,
        targetType: AUDIT_TARGETS.ORIPA_CAMPAIGN,
        targetId: created.id,
        after: {
          slug: created.slug,
          pricePoints: input.pricePoints,
          totalSlots: input.totalSlots,
          tiers: input.tiers.map((t) => ({ code: t.code, slotCount: t.slotCount })),
        },
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      },
      tx,
    )

    return created
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(ERROR_CODES.CONFLICT, 409, 'このスラッグはすでに使われています', {
        meta: { slug: input.slug },
      })
    }
    throw error
  }
}

export async function updateOripaDraft(
  tx: PrismaTransactionClient,
  campaignId: string,
  input: UpdateOripaInput,
  actor: { id: string },
  context: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<{ id: string }> {
  const existing = await tx.oripaCampaign.findFirst({
    where: { id: campaignId, deletedAt: null },
    select: {
      id: true,
      status: true,
      publishedAt: true,
      pricePoints: true,
      salesStartAt: true,
      salesEndAt: true,
    },
  })

  if (!existing) {
    throw errors.notFound('オリパ')
  }

  // 公開後に価格を変更しようとしたら、その項目名を添えて拒否する
  if (existing.publishedAt !== null) {
    if (input.pricePoints !== undefined && input.pricePoints !== existing.pricePoints) {
      throw errors.campaignImmutable('pricePoints')
    }
    // 名称・説明・サムネイルは公開後も直してよい（確率に影響しないため）
  }

  if (existing.status !== CampaignStatus.DRAFT && input.pricePoints !== undefined) {
    throw errors.campaignImmutable('pricePoints')
  }

  const salesStartAt = input.salesStartAt ? new Date(input.salesStartAt) : existing.salesStartAt
  const salesEndAt = input.salesEndAt ? new Date(input.salesEndAt) : existing.salesEndAt

  if (salesEndAt <= salesStartAt) {
    throw errors.validation([
      { field: 'salesEndAt', message: '販売終了日時は販売開始日時より後にしてください' },
    ])
  }

  const updated = await tx.oripaCampaign.update({
    where: { id: campaignId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.thumbnailKey !== undefined ? { thumbnailKey: input.thumbnailKey } : {}),
      ...(input.pricePoints !== undefined ? { pricePoints: input.pricePoints } : {}),
      ...(input.perUserLimit !== undefined ? { perUserLimit: input.perUserLimit } : {}),
      ...(input.salesStartAt !== undefined ? { salesStartAt } : {}),
      ...(input.salesEndAt !== undefined ? { salesEndAt } : {}),
      ...(input.effectSetKey !== undefined ? { effectSetKey: input.effectSetKey } : {}),
    },
    select: { id: true },
  })

  await writeAuditLog(
    {
      actorType: 'ADMIN',
      actorId: actor.id,
      action: AUDIT_ACTIONS.ORIPA_UPDATE,
      targetType: AUDIT_TARGETS.ORIPA_CAMPAIGN,
      targetId: campaignId,
      before: { pricePoints: existing.pricePoints },
      after: { ...input },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    },
    tx,
  )

  return updated
}

/* -------------------------------------------------------------------------- */
/* 公開                                                                        */
/* -------------------------------------------------------------------------- */

export interface PublishCheck {
  /** 公開できるか */
  publishable: boolean
  /** 満たしていない条件 */
  problems: FieldError[]
  /** 確認のために表示する集計 */
  summary: {
    totalSlots: number
    generatedSlots: number
    tierSlotSum: number
    pricePoints: number
    /** 期待値（スロットの交換ポイント合計 ÷ 総口数）。整数比のまま保持する。 */
    expectedValueNumerator: number
    expectedValueDenominator: number
  }
}

/**
 * 公開条件を検証する。
 *
 * 要件（docs/06-draw-algorithm.md §6）:
 *  - 景品ランクの口数合計が総口数と一致する
 *  - 生成済みスロット数が総口数と一致する
 *  - 全スロットに景品（在庫または汎用景品）がある
 *  - 価格が 1 以上
 *  - 交換ポイントが 0 以上
 *  - 販売開始・終了日時が正しい
 *  - 同一物理在庫が重複割当されていない
 *
 * 公開前に管理画面から呼んでチェックリストとして表示する。
 */
export async function checkPublishable(
  tx: PrismaTransactionClient,
  campaignId: string,
): Promise<PublishCheck> {
  const campaign = await tx.oripaCampaign.findFirst({
    where: { id: campaignId, deletedAt: null },
    select: {
      id: true,
      status: true,
      pricePoints: true,
      totalSlots: true,
      salesStartAt: true,
      salesEndAt: true,
      tiers: { select: { code: true, slotCount: true } },
    },
  })

  if (!campaign) {
    throw errors.notFound('オリパ')
  }

  const problems: FieldError[] = []

  if (campaign.status !== CampaignStatus.DRAFT) {
    problems.push({
      field: 'status',
      message: `公開できるのは下書き（DRAFT）のときだけです（現在: ${campaign.status}）`,
    })
  }

  const tierSlotSum = campaign.tiers.reduce((sum, tier) => sum + tier.slotCount, 0)
  if (tierSlotSum !== campaign.totalSlots) {
    problems.push({
      field: 'tiers',
      message: `景品ランクの口数合計（${tierSlotSum}）が総口数（${campaign.totalSlots}）と一致していません`,
    })
  }

  const [generatedSlots, slotsWithoutPrize, negativeExchange, exchangeSum] = await Promise.all([
    tx.oripaSlot.count({ where: { campaignId } }),
    tx.oripaSlot.count({
      where: { campaignId, inventoryId: null, genericPrizeId: null },
    }),
    tx.oripaSlot.count({ where: { campaignId, exchangePoints: { lt: 0 } } }),
    tx.oripaSlot.aggregate({
      where: { campaignId },
      _sum: { exchangePoints: true },
    }),
  ])

  if (generatedSlots !== campaign.totalSlots) {
    problems.push({
      field: 'slots',
      message:
        `生成済みスロット数（${generatedSlots}）が総口数（${campaign.totalSlots}）と一致していません。` +
        '景品割当を実行してください',
    })
  }

  if (slotsWithoutPrize > 0) {
    problems.push({
      field: 'slots',
      message: `景品が設定されていないスロットが ${slotsWithoutPrize} 件あります`,
    })
  }

  if (negativeExchange > 0) {
    problems.push({
      field: 'slots',
      message: '交換ポイントが負のスロットがあります',
    })
  }

  if (campaign.pricePoints < 1) {
    problems.push({ field: 'pricePoints', message: '1 口価格は 1 ポイント以上にしてください' })
  }

  if (campaign.salesEndAt <= campaign.salesStartAt) {
    problems.push({
      field: 'salesEndAt',
      message: '販売終了日時は販売開始日時より後にしてください',
    })
  }

  if (campaign.salesEndAt <= now()) {
    problems.push({
      field: 'salesEndAt',
      message: '販売終了日時がすでに過ぎています',
    })
  }

  // 同一物理在庫の重複割当は DB の UNIQUE で防いでいるが、
  // 「他のオリパへ割当済みの在庫」が混ざっていないかは確認しておく
  const duplicated = await tx.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count
    FROM oripa_slots s
    WHERE s.campaign_id = ${campaignId}
      AND s.inventory_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM oripa_slots other
        WHERE other.inventory_id = s.inventory_id
          AND other.campaign_id <> s.campaign_id
      )
  `
  const duplicatedCount = Number(duplicated[0]?.count ?? 0)
  if (duplicatedCount > 0) {
    problems.push({
      field: 'slots',
      message: `他のオリパと重複している在庫が ${duplicatedCount} 件あります`,
    })
  }

  return {
    publishable: problems.length === 0,
    problems,
    summary: {
      totalSlots: campaign.totalSlots,
      generatedSlots,
      tierSlotSum,
      pricePoints: campaign.pricePoints,
      // 期待値は「交換ポイントの合計 ÷ 総口数」。
      // 浮動小数点にせず、分子・分母のまま保持して表示時に整形する。
      expectedValueNumerator: exchangeSum._sum.exchangePoints ?? 0,
      expectedValueDenominator: campaign.totalSlots,
    },
  }
}

export interface PublishResult {
  id: string
  status: CampaignStatus
  slotOrderCommit: string
}

/**
 * オリパを公開する。
 *
 * 公開時に以下を確定させる。
 *  - スロットの抽選順（すでに生成済み）
 *  - コミットハッシュ（後から差し替えていないことを証明できる）
 *  - 価格・総口数（以後 DB トリガが変更を拒否する）
 *
 * 販売開始日時が未来なら SCHEDULED、現在以前なら ACTIVE になる。
 */
export async function publishOripa(
  tx: PrismaTransactionClient,
  campaignId: string,
  actor: { id: string },
  context: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<PublishResult> {
  const check = await checkPublishable(tx, campaignId)
  if (!check.publishable) {
    throw errors.campaignNotPublishable(check.problems)
  }

  // 保存済みのスロット順からコミットハッシュを作る
  const commitment = await buildCommitment(tx, campaignId)

  const campaign = await tx.oripaCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: {
      id: true,
      pricePoints: true,
      totalSlots: true,
      salesStartAt: true,
      tiers: { select: { code: true, slotCount: true }, orderBy: { displayOrder: 'asc' } },
    },
  })

  const at = now()
  const nextStatus =
    campaign.salesStartAt > at ? CampaignStatus.SCHEDULED : CampaignStatus.ACTIVE

  // 価格・総口数・ランク構成のハッシュ。改変検知用。
  const configLockedHash = sha256Hex(
    JSON.stringify({
      pricePoints: campaign.pricePoints,
      totalSlots: campaign.totalSlots,
      tiers: campaign.tiers,
    }),
  )

  const updated = await tx.oripaCampaign.update({
    where: { id: campaignId },
    data: {
      status: nextStatus,
      publishedAt: at,
      publishedBy: actor.id,
      slotOrderCommit: commitment.slotOrderCommit,
      slotOrderSeed: commitment.serverSeed,
      configLockedHash,
    },
    select: { id: true, status: true, slotOrderCommit: true },
  })

  await writeAuditLog(
    {
      actorType: 'ADMIN',
      actorId: actor.id,
      action: AUDIT_ACTIONS.ORIPA_PUBLISH,
      targetType: AUDIT_TARGETS.ORIPA_CAMPAIGN,
      targetId: campaignId,
      after: {
        status: nextStatus,
        // シードは監査ログにも残さない（漏れると順序が計算できてしまう）
        slotOrderCommit: commitment.slotOrderCommit,
        configLockedHash,
        pricePoints: campaign.pricePoints,
        totalSlots: campaign.totalSlots,
      },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    },
    tx,
  )

  return {
    id: updated.id,
    status: updated.status,
    slotOrderCommit: updated.slotOrderCommit ?? commitment.slotOrderCommit,
  }
}

/** 販売停止（理由必須）。抽選済みの結果には影響しない。 */
export async function suspendOripa(
  tx: PrismaTransactionClient,
  campaignId: string,
  reason: string,
  actor: { id: string },
  context: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<{ id: string; status: CampaignStatus }> {
  const campaign = await tx.oripaCampaign.findFirst({
    where: { id: campaignId, deletedAt: null },
    select: { id: true, status: true },
  })

  if (!campaign) {
    throw errors.notFound('オリパ')
  }

  if (
    campaign.status !== CampaignStatus.ACTIVE &&
    campaign.status !== CampaignStatus.SCHEDULED
  ) {
    throw errors.conflict('販売中または販売前のオリパのみ停止できます', {
      status: campaign.status,
    })
  }

  const updated = await tx.oripaCampaign.update({
    where: { id: campaignId },
    data: {
      status: CampaignStatus.SUSPENDED,
      suspendedAt: now(),
      suspendReason: reason,
    },
    select: { id: true, status: true },
  })

  await writeAuditLog(
    {
      actorType: 'ADMIN',
      actorId: actor.id,
      action: AUDIT_ACTIONS.ORIPA_SUSPEND,
      targetType: AUDIT_TARGETS.ORIPA_CAMPAIGN,
      targetId: campaignId,
      reason,
      before: { status: campaign.status },
      after: { status: CampaignStatus.SUSPENDED },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    },
    tx,
  )

  return updated
}

/**
 * シードを公開する（リビール）。
 *
 * ■ なぜ公開が要るのか
 *   公開時にコミットハッシュ（SHA-256）を保存しているが、
 *   シードを出さない限り第三者は何も検証できない。
 *   「検証できる形で記録してある」と「実際に検証できる」は別物で、
 *   後者にして初めて公正性の主張が成り立つ。
 *
 * ■ 販売終了後にしか公開しない
 *   販売中に出すと、シードから draw_order を再現して
 *   「次に何が出るか」を計算できてしまう。
 *   完売・期間終了・アーカイブのいずれかに達してからだけ許す。
 *
 * ■ 一度きり
 *   公開日時が入ったら二度と変えられない。
 *   「公開したことにして後から差し替える」余地を残さない。
 *   シードそのものは DB トリガ（oripa_campaigns_immutable_trigger）が
 *   公開後の変更を拒否している。
 *
 * ■ 公開前に自己点検する
 *   保存済みのスロット順から再計算したハッシュが
 *   コミットハッシュと一致することを確かめてから公開する。
 *   食い違ったまま公開すると、第三者の検証も当然失敗する。
 *   そのときは公開せずに止め、原因を調べる。
 */
export async function revealSlotOrderSeed(
  tx: PrismaTransactionClient,
  campaignId: string,
  actor: { id: string },
  context: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<{ id: string; revealedAt: Date }> {
  const campaign = await tx.oripaCampaign.findFirst({
    where: { id: campaignId, deletedAt: null },
    select: {
      id: true,
      status: true,
      salesEndAt: true,
      slotOrderCommit: true,
      slotOrderRevealedAt: true,
    },
  })

  if (!campaign) {
    throw errors.notFound('オリパ')
  }

  if (!campaign.slotOrderCommit) {
    throw errors.conflict('公開されていないオリパのシードは公開できません')
  }

  if (campaign.slotOrderRevealedAt) {
    throw errors.conflict('このオリパのシードはすでに公開されています', {
      revealedAt: campaign.slotOrderRevealedAt.toISOString(),
    })
  }

  const at = now()
  const salesEnded =
    campaign.status === CampaignStatus.SOLD_OUT ||
    campaign.status === CampaignStatus.ENDED ||
    campaign.status === CampaignStatus.ARCHIVED ||
    isAfter(at, campaign.salesEndAt)

  if (!salesEnded) {
    throw errors.conflict(
      '販売終了後にのみシードを公開できます（販売中に公開すると次に出るものを計算できてしまいます）',
      { status: campaign.status },
    )
  }

  // 公開前の自己点検。食い違っていたら公開せずに止める。
  const verification = await verifySlotOrderCommitment(tx, campaignId)
  if (!verification.matches) {
    throw errors.conflict(
      'コミットハッシュと保存済みのスロット順が一致しません。公開を中止しました',
      { campaignId },
    )
  }

  const updated = await tx.oripaCampaign.update({
    where: { id: campaignId },
    data: { slotOrderRevealedAt: at },
    select: { id: true, slotOrderRevealedAt: true },
  })

  await writeAuditLog(
    {
      actorType: 'ADMIN',
      actorId: actor.id,
      action: AUDIT_ACTIONS.ORIPA_SEED_REVEAL,
      targetType: AUDIT_TARGETS.ORIPA_CAMPAIGN,
      targetId: campaignId,
      // シードそのものは監査ログへ書かない。公開の事実だけを残す。
      after: { revealedAt: at.toISOString(), commitVerified: true },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    },
    tx,
  )

  return { id: updated.id, revealedAt: updated.slotOrderRevealedAt ?? at }
}

/** 販売停止を解除して再開する */
export async function resumeOripa(
  tx: PrismaTransactionClient,
  campaignId: string,
  reason: string,
  actor: { id: string },
  context: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<{ id: string; status: CampaignStatus }> {
  const campaign = await tx.oripaCampaign.findFirst({
    where: { id: campaignId, deletedAt: null },
    select: { id: true, status: true, salesStartAt: true, salesEndAt: true },
  })

  if (!campaign) throw errors.notFound('オリパ')
  if (campaign.status !== CampaignStatus.SUSPENDED) {
    throw errors.conflict('停止中のオリパのみ再開できます', { status: campaign.status })
  }

  const at = now()
  const nextStatus =
    campaign.salesEndAt <= at
      ? CampaignStatus.ENDED
      : campaign.salesStartAt > at
        ? CampaignStatus.SCHEDULED
        : CampaignStatus.ACTIVE

  const updated = await tx.oripaCampaign.update({
    where: { id: campaignId },
    data: { status: nextStatus, suspendedAt: null, suspendReason: null },
    select: { id: true, status: true },
  })

  await writeAuditLog(
    {
      actorType: 'ADMIN',
      actorId: actor.id,
      action: AUDIT_ACTIONS.ORIPA_RESUME,
      targetType: AUDIT_TARGETS.ORIPA_CAMPAIGN,
      targetId: campaignId,
      reason,
      before: { status: CampaignStatus.SUSPENDED },
      after: { status: nextStatus },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    },
    tx,
  )

  return updated
}

/** 下書きを破棄する（在庫の割当も解除する） */
export async function discardDraft(
  tx: PrismaTransactionClient,
  campaignId: string,
  actor: { id: string },
): Promise<void> {
  const campaign = await tx.oripaCampaign.findFirst({
    where: { id: campaignId, deletedAt: null },
    select: { id: true, status: true, publishedAt: true },
  })

  if (!campaign) throw errors.notFound('オリパ')
  if (campaign.publishedAt !== null || campaign.status !== CampaignStatus.DRAFT) {
    throw errors.campaignImmutable('status')
  }

  const slots = await tx.oripaSlot.findMany({
    where: { campaignId },
    select: { inventoryId: true },
  })
  const inventoryIds = slots
    .map((slot) => slot.inventoryId)
    .filter((id): id is string => id !== null)

  await tx.oripaSlot.deleteMany({ where: { campaignId } })
  await releaseAllocation(tx, inventoryIds)

  await tx.oripaCampaign.update({
    where: { id: campaignId },
    data: { deletedAt: now(), status: CampaignStatus.ARCHIVED },
  })

  await writeAuditLog(
    {
      actorType: 'ADMIN',
      actorId: actor.id,
      action: AUDIT_ACTIONS.ORIPA_UPDATE,
      targetType: AUDIT_TARGETS.ORIPA_CAMPAIGN,
      targetId: campaignId,
      reason: '下書きの破棄',
      after: { status: CampaignStatus.ARCHIVED, releasedInventories: inventoryIds.length },
    },
    tx,
  )
}

/* -------------------------------------------------------------------------- */
/* 一覧（管理画面）                                                            */
/* -------------------------------------------------------------------------- */

export interface AdminOripaListItem {
  id: string
  slug: string
  name: string
  status: CampaignStatus
  pricePoints: number
  totalSlots: number
  remainingSlots: number
  generatedSlots: number
  salesStartAt: Date
  salesEndAt: Date
  publishedAt: Date | null
  createdAt: Date
}

export async function listOripasForAdmin(query: OripaListQuery): Promise<{
  items: AdminOripaListItem[]
  total: number
  page: number
  perPage: number
  totalPages: number
}> {
  const where = {
    deletedAt: null,
    ...(query.status ? { status: query.status } : {}),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' as const } },
            { slug: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  }

  const [total, items] = await Promise.all([
    prisma.oripaCampaign.count({ where }),
    prisma.oripaCampaign.findMany({
      where,
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        pricePoints: true,
        totalSlots: true,
        remainingSlots: true,
        salesStartAt: true,
        salesEndAt: true,
        publishedAt: true,
        createdAt: true,
        _count: { select: { slots: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    }),
  ])

  return {
    items: items.map((item) => ({
      id: item.id,
      slug: item.slug,
      name: item.name,
      status: item.status,
      pricePoints: item.pricePoints,
      totalSlots: item.totalSlots,
      remainingSlots: item.remainingSlots,
      generatedSlots: item._count.slots,
      salesStartAt: item.salesStartAt,
      salesEndAt: item.salesEndAt,
      publishedAt: item.publishedAt,
      createdAt: item.createdAt,
    })),
    total,
    page: query.page,
    perPage: query.perPage,
    totalPages: Math.max(1, Math.ceil(total / query.perPage)),
  }
}

/* -------------------------------------------------------------------------- */
/* 詳細（管理画面）                                                            */
/* -------------------------------------------------------------------------- */

export interface AdminTierSummary {
  id: string
  code: string
  name: string
  effectTier: string
  /** 設定した口数 */
  slotCount: number
  /** 実際に生成されたスロット数 */
  generatedCount: number
  /** まだ引かれていないスロット数 */
  remainingCount: number
  /** うち物理在庫が割り当てられているもの */
  inventoryCount: number
}

export interface AdminOripaDetail {
  id: string
  slug: string
  name: string
  description: string | null
  thumbnailKey: string | null
  pricePoints: number
  totalSlots: number
  remainingSlots: number
  perUserLimit: number | null
  effectSetKey: string
  status: CampaignStatus
  salesStartAt: Date
  salesEndAt: Date
  publishedAt: Date | null
  suspendedAt: Date | null
  suspendReason: string | null
  /** 公開時のコミットハッシュ。シードは返さない。 */
  slotOrderCommit: string | null
  slotOrderRevealedAt: Date | null
  tiers: AdminTierSummary[]
  generatedSlots: number
  publishCheck: PublishCheck
}

/**
 * 管理画面のオリパ詳細。
 *
 * **slot_order_seed と draw_order は返さない。**
 * これらが管理画面へ出ると、内部関係者が「次に何が出るか」を知れてしまう。
 */
export async function getOripaDetailForAdmin(campaignId: string): Promise<AdminOripaDetail> {
  const campaign = await prisma.oripaCampaign.findFirst({
    where: { id: campaignId, deletedAt: null },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      thumbnailKey: true,
      pricePoints: true,
      totalSlots: true,
      remainingSlots: true,
      perUserLimit: true,
      effectSetKey: true,
      status: true,
      salesStartAt: true,
      salesEndAt: true,
      publishedAt: true,
      suspendedAt: true,
      suspendReason: true,
      slotOrderCommit: true,
      slotOrderRevealedAt: true,
      tiers: {
        select: {
          id: true,
          code: true,
          name: true,
          effectTier: true,
          slotCount: true,
          displayOrder: true,
        },
        orderBy: { displayOrder: 'asc' },
      },
    },
  })

  if (!campaign) {
    throw errors.notFound('オリパ')
  }

  const [generatedByTier, remainingByTier, inventoryByTier, publishCheck] = await Promise.all([
    prisma.oripaSlot.groupBy({
      by: ['tierId'],
      where: { campaignId },
      _count: { _all: true },
    }),
    prisma.oripaSlot.groupBy({
      by: ['tierId'],
      where: { campaignId, status: 'AVAILABLE' },
      _count: { _all: true },
    }),
    prisma.oripaSlot.groupBy({
      by: ['tierId'],
      where: { campaignId, inventoryId: { not: null } },
      _count: { _all: true },
    }),
    checkPublishable(prisma, campaignId),
  ])

  const countMap = (rows: { tierId: string; _count: { _all: number } }[]) =>
    new Map(rows.map((row) => [row.tierId, row._count._all]))

  const generated = countMap(generatedByTier)
  const remaining = countMap(remainingByTier)
  const withInventory = countMap(inventoryByTier)

  return {
    ...campaign,
    tiers: campaign.tiers.map((tier) => ({
      id: tier.id,
      code: tier.code,
      name: tier.name,
      effectTier: tier.effectTier,
      slotCount: tier.slotCount,
      generatedCount: generated.get(tier.id) ?? 0,
      remainingCount: remaining.get(tier.id) ?? 0,
      inventoryCount: withInventory.get(tier.id) ?? 0,
    })),
    generatedSlots: publishCheck.summary.generatedSlots,
    publishCheck,
  }
}

export interface AllocationCandidate {
  id: string
  code: string
  cardName: string
  rarity: string | null
  exchangePoints: number
}

/**
 * 景品割当フォームに並べる在庫。
 *
 * 「まだどこにも割り当てられていない在庫」に加え、
 * 「この下書きへすでに割り当てた在庫」も含める。
 * 後者を外すと、再編集のたびに選択済みの在庫が一覧から消えてしまう。
 */
export async function listAllocationCandidates(
  campaignId: string,
  limit = 500,
): Promise<AllocationCandidate[]> {
  return prisma.inventory.findMany({
    where: {
      deletedAt: null,
      OR: [{ status: InventoryStatus.AVAILABLE, slot: { is: null } }, { slot: { campaignId } }],
    },
    select: {
      id: true,
      code: true,
      cardName: true,
      rarity: true,
      exchangePoints: true,
    },
    orderBy: [{ exchangePoints: 'desc' }, { id: 'asc' }],
    take: limit,
  })
}

/** ランクごとの、現在割り当て済みの物理在庫 ID */
export async function listAllocatedInventoryIdsByTier(
  campaignId: string,
): Promise<Map<string, string[]>> {
  const slots = await prisma.oripaSlot.findMany({
    where: { campaignId, inventoryId: { not: null } },
    select: { inventoryId: true, tier: { select: { code: true } } },
  })

  const result = new Map<string, string[]>()
  for (const slot of slots) {
    if (!slot.inventoryId) continue
    const list = result.get(slot.tier.code) ?? []
    list.push(slot.inventoryId)
    result.set(slot.tier.code, list)
  }
  return result
}

export interface GenericPrizeOption {
  code: string
  name: string
  exchangePoints: number
  shippable: boolean
}

/** 不足分を埋めるために選べる汎用景品の一覧 */
export async function listGenericPrizes(): Promise<GenericPrizeOption[]> {
  return prisma.genericPrize.findMany({
    where: { isActive: true },
    select: { code: true, name: true, exchangePoints: true, shippable: true },
    orderBy: { exchangePoints: 'desc' },
  })
}

/**
 * 公開条件のチェックだけを取り出す（API から呼ぶ）。
 * トランザクションを開かず、読み取りのみを行う。
 */
export async function checkPublishableById(campaignId: string): Promise<PublishCheck> {
  return checkPublishable(prisma, campaignId)
}

/** 在庫の状態を「割当済み」へ戻すヘルパー（テスト・保守用） */
export async function releaseCampaignInventories(
  tx: PrismaTransactionClient,
  campaignId: string,
): Promise<number> {
  const slots = await tx.oripaSlot.findMany({
    where: { campaignId },
    select: { inventoryId: true },
  })
  const ids = slots.map((s) => s.inventoryId).filter((id): id is string => id !== null)

  const result = await tx.inventory.updateMany({
    where: { id: { in: ids }, status: InventoryStatus.ALLOCATED },
    data: { status: InventoryStatus.AVAILABLE },
  })
  return result.count
}

export { generateSlots }
