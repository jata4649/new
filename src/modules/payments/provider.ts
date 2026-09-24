import type { PaymentStatus } from '@/generated/prisma/enums.ts'

/**
 * 決済プロバイダのインターフェース。
 *
 * 要件: 「決済処理はインターフェース化する」
 *       「将来的に正式な決済事業者へ差し替えられる構造にする」
 *
 * アプリ側はこのインターフェースにだけ依存する。
 * MVP では MockPaymentProvider を実装し、本番では実事業者の SDK を包んだ
 * 実装へ差し替える。サービス層のコードは変更しない。
 *
 * 【重要】カード情報はこのインターフェースを通らない。
 *   本番でもカード情報はブラウザから決済事業者へ直接送られる想定（PCI DSS の
 *   スコープを持ち込まないため）。このアプリは決済 ID と金額だけを扱う。
 */

export interface CreatePaymentInput {
  /** 冪等性のためにアプリ側が採番する参照 ID */
  referenceId: string
  amountYen: number
  userId: string
  /** 決済後の戻り先。実プロバイダでのリダイレクト用。 */
  returnUrl?: string
}

export interface PaymentResult {
  /** プロバイダ側の決済 ID */
  providerPaymentId: string
  status: PaymentStatus
  amountYen: number
  /** ユーザーを遷移させる先（Mock では使わない） */
  redirectUrl?: string | undefined
  failureCode?: string | undefined
}

export interface WebhookVerificationResult {
  valid: boolean
  /** プロバイダ側のイベント ID。重複排除の要。 */
  eventId: string
  eventType: string
  providerPaymentId: string
  status: PaymentStatus
  /** プロバイダが主張するイベント発生時刻。順序逆転の判定に使う。 */
  occurredAt: Date
  payload: unknown
}

export interface PaymentProvider {
  readonly name: string

  createPayment(input: CreatePaymentInput): Promise<PaymentResult>
  confirmPayment(providerPaymentId: string): Promise<PaymentResult>
  cancelPayment(providerPaymentId: string): Promise<PaymentResult>
  refundPayment(providerPaymentId: string): Promise<PaymentResult>
  getPaymentStatus(providerPaymentId: string): Promise<PaymentResult>

  /**
   * Webhook の署名を検証し、内容を取り出す。
   * 署名が不正なら valid: false を返す（例外は投げない）。
   */
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerificationResult
}
