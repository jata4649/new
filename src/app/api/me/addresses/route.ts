import { withAuthedApi, withIdempotentApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { listAddresses } from '@/modules/addresses/queries.ts'
import { addressInputSchema } from '@/modules/addresses/schema.ts'
import { createAddress } from '@/modules/addresses/service.ts'
import { AUDIT_ACTIONS, writeAuditLog } from '@/modules/audit/service.ts'

/**
 * 配送先の一覧と登録。
 *
 * 住所は個人情報なので、本人のものしか返さない
 * （queries 側で userId を WHERE に必ず含めている）。
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthedApi(
  { auth: 'user', rateLimit: RATE_LIMIT_RULES.read },
  async (ctx) => ({ items: await listAddresses(ctx.session.id) }),
)

export const POST = withIdempotentApi(
  {
    auth: 'user',
    bodySchema: addressInputSchema,
    rateLimit: RATE_LIMIT_RULES.mutation,
    idempotency: { scope: 'address_create' },
    successStatus: 201,
  },
  async (ctx, tx) => {
    const created = await createAddress(tx, {
      userId: ctx.session.id,
      input: ctx.body,
    })

    await writeAuditLog(
      {
        actorType: 'USER',
        actorId: ctx.session.id,
        action: AUDIT_ACTIONS.ADDRESS_CREATE,
        targetType: null,
        targetId: created.id,
        // 住所そのものは監査ログへ残さない。
        // 「いつ誰が登録したか」が追えれば十分で、本文を持つと漏えい面が増える。
        after: { addressId: created.id },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      },
      tx,
    )

    return created
  },
)
