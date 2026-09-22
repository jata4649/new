import { Prisma } from '@/generated/prisma/client.ts'
import { PaymentStatus, PointTxType, PointType } from '@/generated/prisma/enums.ts'
import { errors } from '@/lib/api/errors.ts'
import { now } from '@/lib/datetime/index.ts'
import { yen, yenToPoints } from '@/lib/money/points.ts'
import { logger } from '@/lib/observability/index.ts'
import { AUDIT_ACTIONS, AUDIT_TARGETS, writeAuditLog } from '@/modules/audit/service.ts'
import { grantPoints } from '@/modules/points/ledger.ts'
import { prisma, TRANSACTION_OPTIONS, type PrismaTransactionClient } from '@/server/db.ts'

import { secureToken } from '@/lib/crypto/random.ts'

import { getPaymentProvider, MOCK_PROVIDER_NAME } from './mock-provider.ts'
import type { WebhookVerificationResult } from './provider.ts'

/**
 * 決済とポイント付与。
 *
 * ■ 二重付与を防ぐ 3 つの仕掛け
 *   1. payment_transactions に (provider, provider_payment_id) の UNIQUE
 *   2. payment_webhook_events に (provider, event_id) の UNIQUE（重複 Webhook を排除）
 *   3. point_ledger_entries に (source_type, source_id, tx_type) の UNIQUE
 *      → 決済 1 件に対する PURCHASE 記帳は DB レベルで高々 1 件（INV-9）
 *
 *   3 が最後の砦。1 と 2 をすり抜けても、DB が二重付与を拒否する。
 *
 * ■ 順序逆転への対応
 *   Webhook は順番どおりに届くとは限らない。
 *   終端状態（SUCCEEDED / FAILED / CANCELLED / REFUNDED）へ遷移したあとに
 *   古いイベント（PENDING など）が届いても巻き戻さない。
 *   判定にはプロバイダが主張する occurredAt を使う。
 */

/** 状態ごとの遷移可否。ここに無い遷移はすべて拒否する。 */
const ALLOWED_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [
    PaymentStatus.SUCCEEDED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ],
  // 成功後は返金のみ
  [PaymentStatus.SUCCEEDED]: [PaymentStatus.REFUNDED],
  // 以下は終端。巻き戻さない。
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.CANCELLED]: [],
  [PaymentStatus.REFUNDED]: [],
}

function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export interface RequestContext {
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

export interface CreateTestPaymentInput {
  userId: string
  amountYen: number
}

export interface TestPaymentSummary {
  id: string
  providerPaymentId: string
  amountYen: number
  grantPoints: number
  status: PaymentStatus
}

/**
 * テスト決済を作成する。
 *
 * 冪等性キーは withIdempotentApi が管理するため、ここでは受け取った
 * idempotencyKeyId を記録するだけ。
 */
export async function createTestPayment(
  tx: PrismaTransactionClient,
  input: CreateTestPaymentInput,
  idempotencyKeyId: string,
): Promise<TestPaymentSummary> {
  const amountYen = yen(input.amountYen)
  if (amountYen <= 0) {
    throw errors.validation([{ field: 'amountYen', message: '金額は 1 円以上にしてください' }])
  }

  const grantablePoints = yenToPoints(amountYen)

  const provider = getPaymentProvider()
  // プロバイダ呼び出しは本来ネットワーク I/O。Mock なので即座に返るが、
  // 実プロバイダへ差し替える際はトランザクションの外へ出すこと
  // （トランザクション内で外部 I/O を行うとコネクションが枯渇する）。
  const result = await provider.createPayment({
    referenceId: idempotencyKeyId,
    amountYen,
    userId: input.userId,
  })

  const payment = await tx.paymentTransaction.create({
    data: {
      userId: input.userId,
      provider: provider.name,
      providerPaymentId: result.providerPaymentId,
      amountYen,
      grantPoints: grantablePoints,
      status: result.status,
      idempotencyKeyId,
    },
    select: {
      id: true,
      providerPaymentId: true,
      amountYen: true,
      grantPoints: true,
      status: true,
    },
  })

  return payment
}

export interface ApplyStatusResult {
  paymentId: string
  status: PaymentStatus
  /** ポイントを付与したか（成功への遷移時のみ true） */
  granted: boolean
  grantedPoints: number
}

/**
 * 決済の状態を変更し、成功時のみポイントを付与する。
 *
 * この関数が「決済成功時だけ有償ポイントを付与する」という要件の実装本体。
 * Webhook からも管理画面の操作からも、必ずここを通る。
 */
export async function applyPaymentStatus(
  tx: PrismaTransactionClient,
  paymentId: string,
  nextStatus: PaymentStatus,
  context: RequestContext & { actorId?: string | null } = {},
): Promise<ApplyStatusResult> {
  // 同じ決済への並行操作を直列化する
  const rows = await tx.$queryRaw<
    {
      id: string
      user_id: string
      status: PaymentStatus
      grant_points: number
      grant_ledger_entry_id: string | null
    }[]
  >`
    SELECT id, user_id, status, grant_points, grant_ledger_entry_id
    FROM payment_transactions
    WHERE id = ${paymentId}
    FOR UPDATE
  `

  const payment = rows[0]
  if (!payment) {
    throw errors.notFound('決済')
  }

  if (payment.status === nextStatus) {
    // 同じ状態への再適用は何もしない（冪等）
    return {
      paymentId: payment.id,
      status: payment.status,
      granted: false,
      grantedPoints: 0,
    }
  }

  if (!canTransition(payment.status, nextStatus)) {
    throw errors.paymentNotConfirmable({
      from: payment.status,
      to: nextStatus,
      paymentId,
    })
  }

  const at = now()
  let granted = false
  let grantedPoints = 0
  let grantLedgerEntryId: string | null = payment.grant_ledger_entry_id

  if (nextStatus === PaymentStatus.SUCCEEDED) {
    // 決済 1 件につき PURCHASE 記帳は 1 件まで（DB の UNIQUE でも保証）。
    // ここで防いでも、競合ですり抜けたら DB が拒否する。
    if (grantLedgerEntryId === null) {
      const grant = await grantPoints(tx, {
        userId: payment.user_id,
        amount: payment.grant_points,
        pointType: PointType.PAID,
        txType: PointTxType.PURCHASE,
        sourceType: 'PAYMENT_TRANSACTION',
        sourceId: payment.id,
      })
      grantLedgerEntryId = grant.ledgerEntryId
      grantedPoints = grant.amount
      granted = true
    }
  }

  await tx.paymentTransaction.update({
    where: { id: payment.id },
    data: {
      status: nextStatus,
      grantLedgerEntryId,
      confirmedAt: nextStatus === PaymentStatus.SUCCEEDED ? at : undefined,
      cancelledAt: nextStatus === PaymentStatus.CANCELLED ? at : undefined,
      refundedAt: nextStatus === PaymentStatus.REFUNDED ? at : undefined,
    },
  })

  await writeAuditLog(
    {
      actorType: context.actorId ? 'ADMIN' : 'SYSTEM',
      actorId: context.actorId ?? null,
      action: AUDIT_ACTIONS.PAYMENT_STATUS_CHANGE,
      targetType: AUDIT_TARGETS.PAYMENT_TRANSACTION,
      targetId: payment.id,
      before: { status: payment.status },
      after: { status: nextStatus, granted, grantedPoints },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    },
    tx,
  )

  return { paymentId: payment.id, status: nextStatus, granted, grantedPoints }
}

export interface WebhookOutcome {
  /** 状態遷移を起こしたか */
  applied: boolean
  /** 無視した理由（重複・順序逆転・不正な遷移） */
  skipReason?: string
  status?: PaymentStatus
}

/**
 * Webhook を処理する。
 *
 * 重複・遅延・順序逆転のすべてをここで吸収する。
 *  - 重複     : (provider, event_id) の UNIQUE 違反で検出し、無視する
 *  - 順序逆転 : occurredAt が直近の適用済みイベントより古ければ無視する
 *  - 遅延     : 到着が遅いだけなので、順序が正しければ通常どおり適用する
 *
 * 署名が不正なイベントも **記録だけは残す**（攻撃の検知に必要なため）。
 */
export async function handleWebhook(
  verification: WebhookVerificationResult,
  rawPayload: unknown,
  context: RequestContext = {},
): Promise<WebhookOutcome> {
  if (!verification.valid) {
    // 署名が不正なイベントの eventId は信用できない（空の場合もある）。
    // そのまま記録すると (provider, event_id) の一意制約に衝突し、
    // 2 回目以降が 500 になってしまう。攻撃者が繰り返し送るだけで
    // エラーを量産できてしまうため、記録用の ID はこちらで採番する。
    await recordWebhookEvent(
      prisma,
      { ...verification, eventId: `invalid_${secureToken(12)}` },
      rawPayload,
      null,
      false,
      `署名が不正（申告された eventId: ${verification.eventId || '(無し)'}）`,
    ).catch((error: unknown) => {
      // 記録に失敗しても、呼び出し元へは 401 を返すことを優先する
      logger.warn('署名不正イベントの記録に失敗しました', {
        error: error instanceof Error ? error.message : String(error),
      })
    })

    throw errors.webhookSignatureInvalid({ eventId: verification.eventId })
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const payment = await tx.paymentTransaction.findUnique({
        where: {
          provider_providerPaymentId: {
            provider: MOCK_PROVIDER_NAME,
            providerPaymentId: verification.providerPaymentId,
          },
        },
        select: { id: true, status: true },
      })

      if (!payment) {
        await recordWebhookEvent(
          tx,
          verification,
          rawPayload,
          null,
          false,
          '対象の決済が存在しない',
        )
        // 存在しない決済への Webhook は受理して無視する。
        // 404 を返すとプロバイダが延々と再送してくるため。
        return { applied: false, skipReason: '対象の決済が存在しない' }
      }

      // 直近で適用済みのイベントより古ければ、順序逆転として無視する
      const latestApplied = await tx.paymentWebhookEvent.findFirst({
        where: { paymentTransactionId: payment.id, applied: true },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      })

      if (
        latestApplied &&
        verification.occurredAt.getTime() <= latestApplied.occurredAt.getTime()
      ) {
        await recordWebhookEvent(
          tx,
          verification,
          rawPayload,
          payment.id,
          false,
          '順序逆転（より新しいイベントが適用済み）',
        )
        return { applied: false, skipReason: '順序逆転（より新しいイベントが適用済み）' }
      }

      if (!canTransition(payment.status, verification.status)) {
        const skipReason =
          payment.status === verification.status
            ? '同じ状態への再通知'
            : `許可されない遷移（${payment.status} → ${verification.status}）`
        await recordWebhookEvent(tx, verification, rawPayload, payment.id, false, skipReason)
        return { applied: false, skipReason }
      }

      await recordWebhookEvent(tx, verification, rawPayload, payment.id, true, null)
      const result = await applyPaymentStatus(tx, payment.id, verification.status, context)

      return { applied: true, status: result.status }
    }, TRANSACTION_OPTIONS)
  } catch (error) {
    if (isUniqueViolation(error)) {
      // 同じ event_id が既に記録されている = 重複配信。正常系として無視する。
      logger.info('重複した Webhook を無視しました', { eventId: verification.eventId })
      return { applied: false, skipReason: '重複した Webhook' }
    }
    throw error
  }
}

async function recordWebhookEvent(
  tx: PrismaTransactionClient,
  verification: WebhookVerificationResult,
  rawPayload: unknown,
  paymentTransactionId: string | null,
  applied: boolean,
  skipReason: string | null,
): Promise<void> {
  await tx.paymentWebhookEvent.create({
    data: {
      provider: MOCK_PROVIDER_NAME,
      eventId: verification.eventId,
      eventType: verification.eventType,
      paymentTransactionId,
      occurredAt: verification.occurredAt,
      signatureValid: verification.valid,
      applied,
      skipReason,
      payload: (rawPayload ?? {}) as Prisma.InputJsonValue,
    },
  })
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}
