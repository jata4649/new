import { withAuthedApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { updateUserStatusSchema, userIdParamsSchema } from '@/modules/users/schema.ts'
import { updateUserStatus } from '@/modules/users/service.ts'

/**
 * ユーザーのステータス変更（停止・解除・退会処理）。
 *
 * 理由の入力は Zod スキーマで必須にしている。
 * ACTIVE 以外へ変更した場合は、サービス層が全セッションを失効させる。
 */
export const runtime = 'nodejs'

export const PATCH = withAuthedApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.USER_UPDATE_STATUS,
    paramsSchema: userIdParamsSchema,
    bodySchema: updateUserStatusSchema,
    rateLimit: RATE_LIMIT_RULES.admin,
  },
  async (ctx) =>
    updateUserStatus(
      ctx.params.id,
      ctx.body,
      { id: ctx.session.id, role: ctx.session.role },
      { ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId },
    ),
)
