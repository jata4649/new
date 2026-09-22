import {
  CampaignStatus,
  InventoryStatus,
  PointTxType,
  PrizeStatus,
  SlotStatus,
  type EffectTier,
} from '@/generated/prisma/enums.ts'
import { errors } from '@/lib/api/errors.ts'
import { isAllowedDrawCount } from '@/lib/config/draws.ts'
import { now } from '@/lib/datetime/index.ts'
import { AUDIT_ACTIONS, AUDIT_TARGETS, writeAuditLog } from '@/modules/audit/service.ts'
import { consumePoints } from '@/modules/points/ledger.ts'
import type { PrismaTransactionClient } from '@/server/db.ts'

import { reserveAvailableSlots } from './repository.ts'

/**
 * 抽選の実行。
 *
 * ■ 単一トランザクションであることが唯一かつ最大の安全装置
 *
 *   「ポイントを減らしてから抽選する」という 2 段構えを一切作らない。
 *   スロット確保・ポイント消費・抽選記録・残り口数の更新が
 *   すべて同じトランザクションにあるため、途中でどれか 1 つでも失敗すれば
 *   （0 件更新を含む）すべて巻き戻り、ポイントは 1 ポイントも減らない。
 *
 *   この関数は**自分ではトランザクションを開かない**。
 *   呼び出し側（withIdempotentApi）のトランザクションに必ず収まる。
 *   冪等性キーの INSERT はそのトランザクションの最初の文なので、
 *   同一キーの並行リクエストは一意インデックス上でブロックされ、
 *   先行がコミットすれば重複側はまるごとロールバックして記録済み応答を返す。
 *
 * ■ 実行順序（docs/06-draw-algorithm.md §2）
 *
 *   1. オリパの状態・販売期間の確認（ロックなし）
 *   2. 購入上限の条件付き加算
 *   3. スロット確保（FOR UPDATE SKIP LOCKED）★最も競合する資源を先に押さえる
 *   4. ポイント消費
 *   5. 抽選記録（draw_transactions / draw_results / user_prizes）
 *   6. スロットと在庫の状態遷移（条件付き UPDATE・件数検査つき）
 *   7. 残り口数の更新 ★ホットロウのロック保持時間を最小化するため最後
 *   8. 監査ログ
 *
 *   ロックの獲得順序をすべてのリクエストで揃えている
 *   （購入カウンタ → スロット → ポイントロット → キャンペーン行）ため、
 *   デッドロックは発生しない。
 *
 * ■ 抽選結果はクライアントが決めない
 *
 *   入力は「オリパのスラッグ」と「口数」だけ。
 *   どのスロットを引くかはサーバーが draw_order から決める。
 *   slotId や inventoryId を受け取る経路は存在しない。
 */

export interface DrawParams {
  userId: string
  /** ユーザーが見ていた URL のスラッグ。ID を受け取らないのは推測防止のため。 */
  slug: string
  drawCount: number
  /** 画面に表示していた 1 口価格。指定された場合のみ一致を確認する。 */
  expectedUnitPricePoints?: number | undefined
  /** 冪等性キーの行 ID。台帳のソース ID と抽選記録の紐付けに使う。 */
  idempotencyKeyId: string
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

export interface DrawnPrize {
  /** 10 連の 0..9 */
  sequence: number
  /** 当選商品の ID（交換・発送申請で使う） */
  userPrizeId: string
  name: string
  tierCode: string
  tierName: string
  effectTier: EffectTier
  exchangePoints: number
  imageKey: string | null
  rarity: string | null
  shippable: boolean
}

export interface DrawResultSummary {
  drawTransactionId: string
  campaignName: string
  campaignSlug: string
  drawCount: number
  unitPricePoints: number
  totalPricePoints: number
  /** 抽選後の利用可能ポイント */
  balanceAfter: number
  /** 抽選後の残り口数 */
  remainingSlots: number
  prizes: DrawnPrize[]
}

export async function executeDraw(
  tx: PrismaTransactionClient,
  params: DrawParams,
): Promise<DrawResultSummary> {
  const { userId, slug, drawCount, idempotencyKeyId } = params

  // Zod でも検証済み。サービス層を直接呼ぶ経路（seed・バッチ）のための二重化。
  if (!isAllowedDrawCount(drawCount)) {
    throw errors.invalidDrawCount([1, 10])
  }

  /* ---------------------------------------------------------------------- */
  /* 1. オリパの状態と販売期間                                               */
  /* ---------------------------------------------------------------------- */

  const campaign = await tx.oripaCampaign.findFirst({
    where: { slug, deletedAt: null, publishedAt: { not: null } },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      pricePoints: true,
      perUserLimit: true,
      salesStartAt: true,
      salesEndAt: true,
    },
  })

  if (!campaign) {
    throw errors.notFound('オリパ')
  }

  if (campaign.status !== CampaignStatus.ACTIVE) {
    throw errors.campaignNotOnSale()
  }

  // 期間の判定はサーバー時刻で行う。クライアントの時計は信用しない。
  const at = now()
  if (at < campaign.salesStartAt || at >= campaign.salesEndAt) {
    throw errors.campaignOutOfPeriod()
  }

  // 表示価格とサーバー価格のズレを検出する。
  // 価格の根拠は常にサーバー側。この検査は「古い画面のまま購入させない」ためだけ。
  if (
    params.expectedUnitPricePoints !== undefined &&
    params.expectedUnitPricePoints !== campaign.pricePoints
  ) {
    throw errors.validation([
      {
        field: 'expectedUnitPricePoints',
        message: '価格が変更されています。画面を更新してからもう一度お試しください',
      },
    ])
  }

  // 金額は整数演算のみ。DB の CHECK 制約
  // （total_price_points = unit_price_points * draw_count）とも一致する。
  const unitPricePoints = campaign.pricePoints
  const totalPricePoints = unitPricePoints * drawCount

  /* ---------------------------------------------------------------------- */
  /* 2. 購入上限                                                             */
  /* ---------------------------------------------------------------------- */

  await enforcePurchaseLimit(tx, {
    userId,
    campaignId: campaign.id,
    drawCount,
    perUserLimit: campaign.perUserLimit,
  })

  /* ---------------------------------------------------------------------- */
  /* 3. スロット確保（最も競合する資源を先に押さえる）                        */
  /* ---------------------------------------------------------------------- */

  const slotIds = await reserveAvailableSlots(tx, campaign.id, drawCount)

  if (slotIds.length < drawCount) {
    // 残り口数が足りない、または全スロットが他のリクエストにロックされている。
    // どちらの場合もユーザーから見れば「今は引けない」なので同じ扱いにする。
    throw errors.insufficientSlots({ requested: drawCount, reserved: slotIds.length })
  }

  // 景品の内容を取る。ロックは確保済みなので、他のトランザクションは
  // これらの行を選べない。抽選順に並べて 10 連の sequence を決める。
  const slots = await tx.oripaSlot.findMany({
    where: { id: { in: slotIds } },
    select: {
      id: true,
      drawOrder: true,
      tierId: true,
      exchangePoints: true,
      inventoryId: true,
      genericPrizeId: true,
      tier: { select: { code: true, name: true, effectTier: true } },
      inventory: {
        select: { cardName: true, cardTitle: true, rarity: true, frontImageKey: true },
      },
      genericPrize: { select: { name: true, imageKey: true, shippable: true } },
    },
    orderBy: { drawOrder: 'asc' },
  })

  if (slots.length !== drawCount) {
    // 起こらないはずだが、起きたら整合性が崩れているのでロールバックさせる
    throw errors.insufficientSlots({ requested: drawCount, fetched: slots.length })
  }

  /* ---------------------------------------------------------------------- */
  /* 4. ポイント消費                                                         */
  /* ---------------------------------------------------------------------- */

  const consumption = await consumePoints(tx, {
    userId,
    amount: totalPricePoints,
    txType: PointTxType.DRAW,
    // 冪等性キーの ID をソースにする。台帳の (source_type, source_id, tx_type)
    // UNIQUE により、同じキーでの DRAW 記帳が 2 件作られることが DB 側でも防がれる。
    // 抽選記録の ID をソースにできないのは、その行がまだ存在しないため。
    sourceType: 'DRAW_REQUEST',
    sourceId: idempotencyKeyId,
  })

  /* ---------------------------------------------------------------------- */
  /* 5. 抽選記録（すべてスナップショット）                                    */
  /* ---------------------------------------------------------------------- */

  const drawTransaction = await tx.drawTransaction.create({
    data: {
      userId,
      campaignId: campaign.id,
      drawCount,
      unitPricePoints,
      totalPricePoints,
      ledgerEntryId: consumption.ledgerEntryId,
      idempotencyKeyId,
      clientIp: params.ip ?? null,
      userAgent: params.userAgent ?? null,
    },
    select: { id: true },
  })

  const prizes: DrawnPrize[] = []

  for (const [sequence, slot] of slots.entries()) {
    // 名称・画像・交換ポイントはここで複写する。
    // 後から在庫マスタが変わっても、過去の当選内容は書き換わらない（要件 8）。
    const name = slot.inventory?.cardName ?? slot.genericPrize?.name ?? '景品'
    const imageKey = slot.inventory?.frontImageKey ?? slot.genericPrize?.imageKey ?? null
    const shippable = slot.inventoryId !== null ? true : (slot.genericPrize?.shippable ?? false)

    const drawResult = await tx.drawResult.create({
      data: {
        drawTransactionId: drawTransaction.id,
        sequence,
        slotId: slot.id,
        tierId: slot.tierId,
        tierCodeSnapshot: slot.tier.code,
        tierNameSnapshot: slot.tier.name,
        effectTier: slot.tier.effectTier,
        exchangePoints: slot.exchangePoints,
        cardNameSnapshot: name,
        cardTitleSnapshot: slot.inventory?.cardTitle ?? null,
        raritySnapshot: slot.inventory?.rarity ?? null,
        imageKeySnapshot: imageKey,
      },
      select: { id: true },
    })

    const userPrize = await tx.userPrize.create({
      data: {
        userId,
        drawResultId: drawResult.id,
        inventoryId: slot.inventoryId,
        genericPrizeId: slot.genericPrizeId,
        status: PrizeStatus.UNDECIDED,
        exchangePoints: slot.exchangePoints,
        nameSnapshot: name,
        effectTier: slot.tier.effectTier,
        imageKeySnapshot: imageKey,
        shippable,
      },
      select: { id: true },
    })

    prizes.push({
      sequence,
      userPrizeId: userPrize.id,
      name,
      tierCode: slot.tier.code,
      tierName: slot.tier.name,
      effectTier: slot.tier.effectTier,
      exchangePoints: slot.exchangePoints,
      imageKey,
      rarity: slot.inventory?.rarity ?? null,
      shippable,
    })
  }

  /* ---------------------------------------------------------------------- */
  /* 6. スロットと在庫の状態遷移（条件付き UPDATE + 件数検査）                */
  /* ---------------------------------------------------------------------- */

  const drawnSlots = await tx.oripaSlot.updateMany({
    where: { id: { in: slotIds }, status: SlotStatus.AVAILABLE },
    data: { status: SlotStatus.DRAWN, drawnByUserId: userId, drawnAt: at },
  })

  if (drawnSlots.count !== drawCount) {
    // ロックの取りこぼしがあった場合の最終防衛線。
    // ここで投げればトランザクションごと巻き戻るので、二重当選は成立しない。
    throw errors.insufficientSlots({ requested: drawCount, updated: drawnSlots.count })
  }

  const wonInventoryIds = slots
    .map((slot) => slot.inventoryId)
    .filter((id): id is string => id !== null)

  if (wonInventoryIds.length > 0) {
    const wonInventories = await tx.inventory.updateMany({
      where: { id: { in: wonInventoryIds }, status: InventoryStatus.ALLOCATED },
      data: { status: InventoryStatus.WON },
    })
    if (wonInventories.count !== wonInventoryIds.length) {
      throw errors.insufficientSlots({
        requested: wonInventoryIds.length,
        updated: wonInventories.count,
      })
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 7. 残り口数（最後に更新してホットロウのロック時間を最小化）              */
  /* ---------------------------------------------------------------------- */

  // status も条件に含める。判定（手順 1）のあとに管理者が販売停止した場合、
  // ここで 0 件になりトランザクションごと巻き戻る。
  // 手順 1 で行ロックを取らないのは、同一オリパへの抽選をすべて直列化してしまうため。
  const decremented = await tx.oripaCampaign.updateMany({
    where: {
      id: campaign.id,
      status: CampaignStatus.ACTIVE,
      remainingSlots: { gte: drawCount },
    },
    data: { remainingSlots: { decrement: drawCount } },
  })

  if (decremented.count !== 1) {
    throw errors.campaignNotOnSale()
  }

  const updatedCampaign = await tx.oripaCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    select: { remainingSlots: true },
  })

  // 売り切れたら状態を進める。残り口数が真実で、status は表示用の従属値。
  if (updatedCampaign.remainingSlots === 0) {
    await tx.oripaCampaign.update({
      where: { id: campaign.id },
      data: { status: CampaignStatus.SOLD_OUT, soldOutAt: at },
    })
  }

  /* ---------------------------------------------------------------------- */
  /* 8. 監査ログ                                                             */
  /* ---------------------------------------------------------------------- */

  await writeAuditLog(
    {
      actorType: 'USER',
      actorId: userId,
      action: AUDIT_ACTIONS.DRAW_EXECUTED,
      targetType: AUDIT_TARGETS.ORIPA_CAMPAIGN,
      targetId: campaign.id,
      after: {
        drawTransactionId: drawTransaction.id,
        drawCount,
        totalPricePoints,
        // 景品名は残すが、スロット ID と抽選順は残さない。
        // 監査ログから次に出るものを推測できてしまうため。
        tierCodes: prizes.map((prize) => prize.tierCode),
        remainingSlots: updatedCampaign.remainingSlots,
      },
      ip: params.ip,
      userAgent: params.userAgent,
      requestId: params.requestId,
    },
    tx,
  )

  return {
    drawTransactionId: drawTransaction.id,
    campaignName: campaign.name,
    campaignSlug: campaign.slug,
    drawCount,
    unitPricePoints,
    totalPricePoints,
    balanceAfter: consumption.balanceAfter,
    remainingSlots: updatedCampaign.remainingSlots,
    prizes,
  }
}

/**
 * 購入上限を適用する。
 *
 * カウンタ行を作ってから**条件付きで加算**する。
 * 加算が 0 件なら上限超過。UPDATE は行ロックを取ってから WHERE を再評価するので、
 * 同時リクエストでも上限を超えない（READ COMMITTED での UPDATE の再チェック）。
 *
 * 行の作成に upsert ではなく createMany(skipDuplicates) を使うのは、
 * `INSERT ... ON CONFLICT DO NOTHING` に落ちることが保証されており、
 * 同時作成で一意制約違反にならないため。
 */
async function enforcePurchaseLimit(
  tx: PrismaTransactionClient,
  params: {
    userId: string
    campaignId: string
    drawCount: number
    perUserLimit: number | null
  },
): Promise<void> {
  const { userId, campaignId, drawCount, perUserLimit } = params

  // 1 回の要求が上限そのものを超えている場合。
  // 加算条件だけでは新規作成時に弾けないため、先に検査する。
  if (perUserLimit !== null && drawCount > perUserLimit) {
    throw errors.purchaseLimitExceeded(perUserLimit)
  }

  await tx.userCampaignCounter.createMany({
    data: [{ userId, campaignId, drawnCount: 0 }],
    skipDuplicates: true,
  })

  const incremented = await tx.userCampaignCounter.updateMany({
    where: {
      userId,
      campaignId,
      // 上限なしの場合は条件を付けない
      ...(perUserLimit !== null ? { drawnCount: { lte: perUserLimit - drawCount } } : {}),
    },
    data: { drawnCount: { increment: drawCount } },
  })

  if (incremented.count !== 1) {
    throw errors.purchaseLimitExceeded(perUserLimit ?? 0)
  }
}
