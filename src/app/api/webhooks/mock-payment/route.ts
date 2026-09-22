import { NextResponse, type NextRequest } from 'next/server'

import { AppError, errors } from '@/lib/api/errors.ts'
import { jsonFailure, successBody } from '@/lib/api/response.ts'
import { newRequestId } from '@/lib/crypto/random.ts'
import { captureException, logger } from '@/lib/observability/index.ts'
import { checkRateLimit, RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { getPaymentProvider } from '@/modules/payments/mock-provider.ts'
import { handleWebhook } from '@/modules/payments/service.ts'

/**
 * Mock 決済プロバイダからの Webhook 受信。
 *
 * withApi を使わず自前で組み立てている理由:
 *  - 認証はセッションではなく **署名** で行う
 *  - 署名検証には生のリクエストボディが必要（JSON パース前の文字列）
 *  - 冪等性はアプリの冪等性キーではなく、プロバイダの event_id で担保する
 *
 * 重複・遅延・順序逆転の扱いは service.ts の handleWebhook を参照。
 *
 * 【重要】エラーでも極力 200 を返す
 *   4xx / 5xx を返すとプロバイダが延々と再送してくる。
 *   「受理したが適用しなかった」は正常系として 200 で返し、
 *   理由は payment_webhook_events に記録する。
 *   署名不正だけは 401 を返す（再送させる意味が無く、攻撃の可能性があるため）。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 署名検証の前に本文を読むため、サイズを制限する */
const MAX_BODY_BYTES = 64 * 1024

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId()
  const meta = { requestId }

  try {
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip')

    const rateLimit = await checkRateLimit(RATE_LIMIT_RULES.webhook, ip ?? 'webhook')
    if (!rateLimit.allowed) {
      throw errors.rateLimited(rateLimit.retryAfterSeconds)
    }

    const rawBody = await req.text()
    if (rawBody.length > MAX_BODY_BYTES) {
      throw errors.validation([{ field: '(body)', message: '本文が大きすぎます' }])
    }

    const verification = getPaymentProvider().verifyWebhook(rawBody, req.headers)

    let parsedPayload: unknown = null
    try {
      parsedPayload = JSON.parse(rawBody)
    } catch {
      parsedPayload = null
    }

    const outcome = await handleWebhook(verification, parsedPayload, {
      ip,
      userAgent: req.headers.get('user-agent'),
      requestId,
    })

    logger.info('Webhook を処理しました', {
      requestId,
      eventId: verification.eventId,
      applied: outcome.applied,
      skipReason: outcome.skipReason,
    })

    // 適用しなかった場合も 200。プロバイダの再送を止めるため。
    return NextResponse.json(successBody(outcome, meta), { status: 200 })
  } catch (error) {
    if (AppError.isAppError(error)) {
      if (error.httpStatus >= 500) {
        captureException(error, { requestId, route: 'POST /api/webhooks/mock-payment' })
      } else {
        logger.warn('Webhook を拒否しました', {
          requestId,
          code: error.code,
          detail: error.meta,
        })
      }
      return jsonFailure(error, { meta })
    }

    captureException(error, { requestId, route: 'POST /api/webhooks/mock-payment' })
    return jsonFailure(errors.internal(error), { meta })
  }
}
