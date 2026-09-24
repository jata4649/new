import { withApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { signupSchema } from '@/modules/auth/schema.ts'
import { signup } from '@/modules/auth/service.ts'

/**
 * 新規会員登録。
 *
 * 登録しただけではログイン状態にならない。
 * 続けてログイン処理を行うかどうかはクライアント側の判断に委ねる
 * （将来メール確認を必須にしたときに、この境界がそのまま使える）。
 */
export const runtime = 'nodejs'

export const POST = withApi(
  {
    auth: 'none',
    bodySchema: signupSchema,
    rateLimit: RATE_LIMIT_RULES.signup,
    successStatus: 201,
  },
  async (ctx) =>
    signup(ctx.body, {
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    }),
)
