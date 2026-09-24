import { withAuthedApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { revokeAllSessions, revokeSession } from '@/modules/auth/service.ts'
import { z } from 'zod'

/**
 * ログアウト。
 *
 * Auth.js の signOut は Cookie を消すだけで、サーバー側のセッション行は残る。
 * 失効させないと「Cookie を復元すれば再び使える」状態になるため、
 * user_sessions.revoked_at を必ず立てる。
 */
export const runtime = 'nodejs'

const logoutSchema = z.object({
  /** true なら全端末からログアウトする */
  allDevices: z.boolean().default(false),
})

export const POST = withAuthedApi(
  {
    auth: 'user',
    bodySchema: logoutSchema,
    rateLimit: RATE_LIMIT_RULES.mutation,
  },
  async (ctx) => {
    const context = {
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    }

    if (ctx.body.allDevices) {
      const revokedCount = await revokeAllSessions(
        ctx.session.id,
        'ユーザー操作による全端末ログアウト',
        context,
      )
      return { revokedCount }
    }

    await revokeSession(ctx.session.sessionId, 'ユーザー操作によるログアウト', context)
    return { revokedCount: 1 }
  },
)
