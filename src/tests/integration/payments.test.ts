import { describe, expect, it } from 'vitest'

import { PaymentStatus, PointTxType, PointType } from '@/generated/prisma/enums.ts'
import { AppError, ERROR_CODES } from '@/lib/api/errors.ts'
import { addDays, now } from '@/lib/datetime/index.ts'
import {
  getPaymentProvider,
  MOCK_EVENT_ID_HEADER,
  MOCK_SIGNATURE_HEADER,
  signPayload,
} from '@/modules/payments/mock-provider.ts'
import {
  applyPaymentStatus,
  createTestPayment,
  handleWebhook,
} from '@/modules/payments/service.ts'
import { getBalance } from '@/modules/points/ledger.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * テスト決済と Webhook の統合テスト。
 *
 * 特に検証したいこと:
 *  - 決済成功時「だけ」ポイントが付与される
 *  - 同じ決済・同じ Webhook が何度来ても二重付与されない
 *  - 順序逆転した Webhook が状態を巻き戻さない
 */

async function createUser(email = 'payer@example.test') {
  const user = await testPrisma.user.create({
    data: {
      email,
      passwordHash: 'dummy-hash',
      profile: { create: { displayName: 'テスト' } },
      pointAccount: { create: {} },
    },
    select: { id: true },
  })
  return user.id
}

let idempotencyCounter = 0

/**
 * 決済を 1 件作る。
 *
 * payment_transactions.idempotency_key_id には外部キーがあるため、
 * 実際のリクエストと同じく先に冪等性キーの行を作る
 * （本番では withIdempotentApi が作る）。
 */
async function createPayment(userId: string, amountYen = 1_000) {
  const key = await testPrisma.idempotencyKey.create({
    data: {
      userId,
      scope: 'test_payment',
      key: `test-key-${++idempotencyCounter}`,
      requestHash: 'test-hash',
      expiresAt: addDays(now(), 1),
    },
    select: { id: true },
  })

  return testPrisma.$transaction((tx) => createTestPayment(tx, { userId, amountYen }, key.id))
}

/** 署名つきの Webhook を組み立てて処理させる */
async function deliverWebhook(input: {
  eventId: string
  providerPaymentId: string
  status: PaymentStatus
  occurredAt: Date
  eventType?: string
  tamper?: boolean
}) {
  const body = JSON.stringify({
    eventId: input.eventId,
    eventType: input.eventType ?? 'payment.updated',
    providerPaymentId: input.providerPaymentId,
    status: input.status,
    occurredAt: input.occurredAt.toISOString(),
  })

  const headers = new Headers({
    [MOCK_SIGNATURE_HEADER]: input.tamper ? signPayload(`${body}x`) : signPayload(body),
    [MOCK_EVENT_ID_HEADER]: input.eventId,
  })

  const verification = getPaymentProvider().verifyWebhook(body, headers)
  return handleWebhook(verification, JSON.parse(body))
}

describe('createTestPayment', () => {
  it('PENDING で作成し、この時点ではポイントを付与しない', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId, 1_000)

    expect(payment.status).toBe(PaymentStatus.PENDING)
    expect(payment.grantPoints).toBe(1_000)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.total).toBe(0)
  })

  it('1 円 = 1 ポイントで換算する', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId, 3_000)
    expect(payment.grantPoints).toBe(3_000)
  })

  it('金額が 0 以下なら拒否する', async () => {
    const userId = await createUser()

    const key = await testPrisma.idempotencyKey.create({
      data: {
        userId,
        scope: 'test_payment',
        key: 'zero-amount',
        requestHash: 'h',
        expiresAt: addDays(now(), 1),
      },
      select: { id: true },
    })

    await expect(
      testPrisma.$transaction((tx) => createTestPayment(tx, { userId, amountYen: 0 }, key.id)),
    ).rejects.toThrow()
  })
})

describe('applyPaymentStatus', () => {
  it('成功時だけ有償ポイントを付与する', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId, 1_000)

    const result = await testPrisma.$transaction((tx) =>
      applyPaymentStatus(tx, payment.id, PaymentStatus.SUCCEEDED),
    )

    expect(result.granted).toBe(true)
    expect(result.grantedPoints).toBe(1_000)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.paid).toBe(1_000)
    expect(balance.free).toBe(0)
  })

  it('失敗時はポイントを付与しない', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId)

    const result = await testPrisma.$transaction((tx) =>
      applyPaymentStatus(tx, payment.id, PaymentStatus.FAILED),
    )

    expect(result.granted).toBe(false)
    const balance = await getBalance(testPrisma, userId)
    expect(balance.total).toBe(0)
  })

  it('取消し時もポイントを付与しない', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId)

    await testPrisma.$transaction((tx) =>
      applyPaymentStatus(tx, payment.id, PaymentStatus.CANCELLED),
    )

    const balance = await getBalance(testPrisma, userId)
    expect(balance.total).toBe(0)
  })

  it('同じ状態への再適用は何もしない（冪等）', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId, 1_000)

    await testPrisma.$transaction((tx) =>
      applyPaymentStatus(tx, payment.id, PaymentStatus.SUCCEEDED),
    )
    const second = await testPrisma.$transaction((tx) =>
      applyPaymentStatus(tx, payment.id, PaymentStatus.SUCCEEDED),
    )

    expect(second.granted).toBe(false)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.paid, '二重付与されていないこと').toBe(1_000)

    const purchaseEntries = await testPrisma.pointLedgerEntry.count({
      where: { userId, txType: PointTxType.PURCHASE },
    })
    expect(purchaseEntries).toBe(1)
  })

  it('終端状態からは巻き戻せない', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId)

    await testPrisma.$transaction((tx) =>
      applyPaymentStatus(tx, payment.id, PaymentStatus.FAILED),
    )

    await expect(
      testPrisma.$transaction((tx) =>
        applyPaymentStatus(tx, payment.id, PaymentStatus.SUCCEEDED),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      if (!AppError.isAppError(error)) return false
      expect(error.code).toBe(ERROR_CODES.PAYMENT_NOT_CONFIRMABLE)
      return true
    })

    const balance = await getBalance(testPrisma, userId)
    expect(balance.total).toBe(0)
  })

  it('成功後は返金へ遷移できる', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId, 1_000)

    await testPrisma.$transaction((tx) =>
      applyPaymentStatus(tx, payment.id, PaymentStatus.SUCCEEDED),
    )
    const refunded = await testPrisma.$transaction((tx) =>
      applyPaymentStatus(tx, payment.id, PaymentStatus.REFUNDED),
    )

    expect(refunded.status).toBe(PaymentStatus.REFUNDED)

    const record = await testPrisma.paymentTransaction.findUnique({
      where: { id: payment.id },
      select: { refundedAt: true },
    })
    expect(record?.refundedAt).not.toBeNull()
  })

  it('状態変更を監査ログへ記録する', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId)

    await testPrisma.$transaction((tx) =>
      applyPaymentStatus(tx, payment.id, PaymentStatus.SUCCEEDED),
    )

    const log = await testPrisma.auditLog.findFirst({
      where: { action: 'PAYMENT_STATUS_CHANGE', targetId: payment.id },
    })
    expect(log?.before).toEqual({ status: 'PENDING' })
  })
})

describe('決済の二重付与防止（INV-9）', () => {
  it('同一決済から PURCHASE 記帳を 2 件作れない（DB の UNIQUE）', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId, 1_000)

    await testPrisma.$transaction((tx) =>
      applyPaymentStatus(tx, payment.id, PaymentStatus.SUCCEEDED),
    )

    // サービス層を迂回して直接記帳を試みても DB が拒否する
    await expect(
      testPrisma.pointLedgerEntry.create({
        data: {
          userId,
          txType: PointTxType.PURCHASE,
          pointType: PointType.PAID,
          amount: 1_000,
          balanceAfter: 2_000,
          sourceType: 'PAYMENT_TRANSACTION',
          sourceId: payment.id,
        },
      }),
    ).rejects.toThrow()
  })
})

describe('handleWebhook', () => {
  it('署名が正しい Webhook を適用し、ポイントを付与する', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId, 1_000)

    const outcome = await deliverWebhook({
      eventId: 'evt_1',
      providerPaymentId: payment.providerPaymentId,
      status: PaymentStatus.SUCCEEDED,
      occurredAt: now(),
    })

    expect(outcome.applied).toBe(true)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.paid).toBe(1_000)
  })

  it('署名が不正なら拒否し、記録だけ残す', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId)

    await expect(
      deliverWebhook({
        eventId: 'evt_bad',
        providerPaymentId: payment.providerPaymentId,
        status: PaymentStatus.SUCCEEDED,
        occurredAt: now(),
        tamper: true,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!AppError.isAppError(error)) return false
      expect(error.code).toBe(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID)
      return true
    })

    // 攻撃検知のため、署名不正も記録する
    const event = await testPrisma.paymentWebhookEvent.findFirst({
      where: { signatureValid: false },
      select: { applied: true, skipReason: true },
    })
    expect(event?.applied).toBe(false)
    expect(event?.skipReason).toContain('署名')

    const balance = await getBalance(testPrisma, userId)
    expect(balance.total).toBe(0)
  })

  it('同じ event_id の重複配信ではポイントを二重付与しない', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId, 1_000)

    const payload = {
      eventId: 'evt_dup',
      providerPaymentId: payment.providerPaymentId,
      status: PaymentStatus.SUCCEEDED,
      occurredAt: now(),
    }

    const first = await deliverWebhook(payload)
    const second = await deliverWebhook(payload)

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
    expect(second.skipReason).toContain('重複')

    const balance = await getBalance(testPrisma, userId)
    expect(balance.paid).toBe(1_000)
  })

  it('順序逆転した Webhook は状態を巻き戻さない', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId, 1_000)

    const later = now()
    const earlier = addDays(later, -1)

    // 新しいイベント（成功）が先に届く
    await deliverWebhook({
      eventId: 'evt_new',
      providerPaymentId: payment.providerPaymentId,
      status: PaymentStatus.SUCCEEDED,
      occurredAt: later,
    })

    // 古いイベント（失敗）が遅れて届く
    const outcome = await deliverWebhook({
      eventId: 'evt_old',
      providerPaymentId: payment.providerPaymentId,
      status: PaymentStatus.FAILED,
      occurredAt: earlier,
    })

    expect(outcome.applied).toBe(false)
    expect(outcome.skipReason).toContain('順序逆転')

    const record = await testPrisma.paymentTransaction.findUnique({
      where: { id: payment.id },
      select: { status: true },
    })
    expect(record?.status).toBe(PaymentStatus.SUCCEEDED)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.paid).toBe(1_000)
  })

  it('遅延した Webhook でも、順序が正しければ適用する', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId, 1_000)

    // occurredAt は過去だが、まだ何も適用されていないので処理される
    const outcome = await deliverWebhook({
      eventId: 'evt_delayed',
      providerPaymentId: payment.providerPaymentId,
      status: PaymentStatus.SUCCEEDED,
      occurredAt: addDays(now(), -1),
    })

    expect(outcome.applied).toBe(true)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.paid).toBe(1_000)
  })

  it('存在しない決済への Webhook は受理して無視する（再送を止めるため）', async () => {
    const outcome = await deliverWebhook({
      eventId: 'evt_unknown',
      providerPaymentId: 'mock_pi_does_not_exist',
      status: PaymentStatus.SUCCEEDED,
      occurredAt: now(),
    })

    expect(outcome.applied).toBe(false)
    expect(outcome.skipReason).toContain('存在しない')
  })

  it('許可されない遷移は適用せず、理由を記録する', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId)

    await testPrisma.$transaction((tx) =>
      applyPaymentStatus(tx, payment.id, PaymentStatus.CANCELLED),
    )

    const outcome = await deliverWebhook({
      eventId: 'evt_after_cancel',
      providerPaymentId: payment.providerPaymentId,
      status: PaymentStatus.SUCCEEDED,
      occurredAt: addDays(now(), 1),
    })

    expect(outcome.applied).toBe(false)
    expect(outcome.skipReason).toContain('許可されない遷移')

    const balance = await getBalance(testPrisma, userId)
    expect(balance.total).toBe(0)
  })

  it('すべての受信イベントを記録する（適用しなかったものも含む）', async () => {
    const userId = await createUser()
    const payment = await createPayment(userId)

    await deliverWebhook({
      eventId: 'evt_a',
      providerPaymentId: payment.providerPaymentId,
      status: PaymentStatus.SUCCEEDED,
      occurredAt: now(),
    })
    await deliverWebhook({
      eventId: 'evt_b',
      providerPaymentId: payment.providerPaymentId,
      status: PaymentStatus.FAILED,
      occurredAt: addDays(now(), -1),
    })

    const events = await testPrisma.paymentWebhookEvent.findMany({
      where: { paymentTransactionId: payment.id },
      orderBy: { receivedAt: 'asc' },
      select: { eventId: true, applied: true },
    })

    expect(events).toHaveLength(2)
    expect(events[0]?.applied).toBe(true)
    expect(events[1]?.applied).toBe(false)
  })
})
