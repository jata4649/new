import { createHmac, timingSafeEqual } from 'node:crypto'

import { PaymentStatus } from '@/generated/prisma/enums.ts'
import { serverEnv } from '@/lib/config/env.ts'
import { secureToken } from '@/lib/crypto/random.ts'
import { now } from '@/lib/datetime/index.ts'

import type {
  CreatePaymentInput,
  PaymentProvider,
  PaymentResult,
  WebhookVerificationResult,
} from './provider.ts'

/**
 * 開発・テスト用の決済プロバイダ。
 *
 * 【重要】現金は一切扱わない。
 *   実在するカード情報を入力させず、保存もしない。
 *   このプロバイダは「決済 ID を発行し、指示された状態を返す」だけ。
 *
 * 状態は DB（payment_transactions）が持つ。
 * このプロバイダ自身は状態を保持しない（ステートレス）ため、
 * プロセスを再起動しても挙動が変わらない。
 *
 * 状態の遷移はテスト管理画面から明示的に指示する:
 *   成功 / 失敗 / 処理中 / 取消し / 返金
 * Webhook の重複・遅延・順序逆転も同じ画面から再現できる
 * （src/modules/payments/service.ts の handleWebhook を参照）。
 */

export const MOCK_PROVIDER_NAME = 'mock'

/** Webhook の署名ヘッダ名。実プロバイダに合わせた形にしておく。 */
export const MOCK_SIGNATURE_HEADER = 'x-mock-signature'
export const MOCK_EVENT_ID_HEADER = 'x-mock-event-id'

export interface MockWebhookPayload {
  eventId: string
  eventType: string
  providerPaymentId: string
  status: PaymentStatus
  /** ISO 8601。遅延・順序逆転の再現ではここを操作する。 */
  occurredAt: string
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = MOCK_PROVIDER_NAME

  createPayment(input: CreatePaymentInput): Promise<PaymentResult> {
    // プロバイダ側 ID を模した値。参照 ID を含めて追跡しやすくする。
    const providerPaymentId = `mock_pi_${input.referenceId}_${secureToken(8)}`

    return Promise.resolve({
      providerPaymentId,
      // 実プロバイダと同じく、作成直後は未確定
      status: PaymentStatus.PENDING,
      amountYen: input.amountYen,
    })
  }

  confirmPayment(providerPaymentId: string): Promise<PaymentResult> {
    return Promise.resolve({
      providerPaymentId,
      status: PaymentStatus.SUCCEEDED,
      // 金額は DB 側が保持している。プロバイダは状態だけを返す。
      amountYen: 0,
    })
  }

  cancelPayment(providerPaymentId: string): Promise<PaymentResult> {
    return Promise.resolve({
      providerPaymentId,
      status: PaymentStatus.CANCELLED,
      amountYen: 0,
    })
  }

  refundPayment(providerPaymentId: string): Promise<PaymentResult> {
    return Promise.resolve({
      providerPaymentId,
      status: PaymentStatus.REFUNDED,
      amountYen: 0,
    })
  }

  getPaymentStatus(providerPaymentId: string): Promise<PaymentResult> {
    // Mock は状態を持たないため、問い合わせでは PENDING を返す。
    // 実際の状態は payment_transactions を参照すること。
    return Promise.resolve({
      providerPaymentId,
      status: PaymentStatus.PENDING,
      amountYen: 0,
    })
  }

  /**
   * Webhook の署名検証。
   *
   * 実プロバイダと同じく HMAC-SHA256 で検証する。
   * 比較は timingSafeEqual で行い、署名の一致度から情報が漏れないようにする。
   */
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerificationResult {
    const invalid = (): WebhookVerificationResult => ({
      valid: false,
      eventId: headers.get(MOCK_EVENT_ID_HEADER) ?? '',
      eventType: 'unknown',
      providerPaymentId: '',
      status: PaymentStatus.PENDING,
      occurredAt: now(),
      payload: null,
    })

    const signature = headers.get(MOCK_SIGNATURE_HEADER)
    if (!signature) return invalid()

    const expected = signPayload(rawBody)
    if (!safeEqualHex(signature, expected)) return invalid()

    let payload: MockWebhookPayload
    try {
      payload = JSON.parse(rawBody) as MockWebhookPayload
    } catch {
      return invalid()
    }

    if (
      typeof payload.eventId !== 'string' ||
      typeof payload.providerPaymentId !== 'string' ||
      typeof payload.occurredAt !== 'string' ||
      !isPaymentStatus(payload.status)
    ) {
      return invalid()
    }

    const occurredAt = new Date(payload.occurredAt)
    if (Number.isNaN(occurredAt.getTime())) return invalid()

    return {
      valid: true,
      eventId: payload.eventId,
      eventType: payload.eventType ?? 'payment.updated',
      providerPaymentId: payload.providerPaymentId,
      status: payload.status,
      occurredAt,
      payload,
    }
  }
}

/** テスト用 Webhook の署名を作る（開発用 UI と統合テストから使う） */
export function signPayload(rawBody: string): string {
  return createHmac('sha256', serverEnv().MOCK_PAYMENT_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

function isPaymentStatus(value: unknown): value is PaymentStatus {
  return (
    typeof value === 'string' && Object.values(PaymentStatus).includes(value as PaymentStatus)
  )
}

let provider: PaymentProvider | null = null

/**
 * 設定されたプロバイダを返す。
 * PAYMENT_PROVIDER は現状 'mock' のみを許可している（env.ts）。
 * 本番プロバイダを追加する際は、ここに分岐を 1 つ足すだけで済む。
 */
export function getPaymentProvider(): PaymentProvider {
  provider ??= new MockPaymentProvider()
  return provider
}

/** テストから差し替える */
export function setPaymentProvider(next: PaymentProvider): void {
  provider = next
}
