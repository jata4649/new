import { withAuthedApi } from '@/lib/api/with-api.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { listAuditLogs } from '@/modules/audit/queries.ts'
import { auditLogListQuerySchema } from '@/modules/audit/schema.ts'

/**
 * 監査ログ（管理画面）。
 *
 * 参照専用。書き込み・更新・削除のエンドポイントは作らない。
 * audit_logs は追記専用で、DB トリガが UPDATE / DELETE を拒否する。
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.AUDIT_READ,
    querySchema: auditLogListQuerySchema,
    rateLimit: RATE_LIMIT_RULES.admin,
  },
  async (ctx) => listAuditLogs(ctx.query),
)
