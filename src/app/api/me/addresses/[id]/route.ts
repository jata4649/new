import { withIdempotentApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'
import { AUDIT_ACTIONS, writeAuditLog } from '@/modules/audit/service.ts'
import { addressIdParamsSchema, addressUpdateSchema } from '@/modules/addresses/schema.ts'
import { deleteAddress, updateAddress } from '@/modules/addresses/service.ts'

/**
 * 配送先の更新と削除。
 *
 * 所有者チェックは service 側の WHERE 句で行う。
 * 他人の住所は「存在しない（404）」として扱い、ID の存在を推測させない。
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const PATCH = withIdempotentApi(
  {
    auth: 'user',
    paramsSchema: addressIdParamsSchema,
    bodySchema: addressUpdateSchema,
    rateLimit: RATE_LIMIT_RULES.mutation,
    idempotency: { scope: 'address_update' },
  },
  async (ctx, tx) => {
    const updated = await updateAddress(tx, {
      userId: ctx.session.id,
      addressId: ctx.params.id,
      input: ctx.body,
    })

    await writeAuditLog(
      {
        actorType: 'USER',
        actorId: ctx.session.id,
        action: AUDIT_ACTIONS.ADDRESS_UPDATE,
        targetId: updated.id,
        after: { addressId: updated.id, fields: Object.keys(ctx.body) },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      },
      tx,
    )

    return updated
  },
)

export const DELETE = withIdempotentApi(
  {
    auth: 'user',
    paramsSchema: addressIdParamsSchema,
    rateLimit: RATE_LIMIT_RULES.mutation,
    idempotency: { scope: 'address_delete' },
  },
  async (ctx, tx) => {
    const deleted = await deleteAddress(tx, {
      userId: ctx.session.id,
      addressId: ctx.params.id,
    })

    await writeAuditLog(
      {
        actorType: 'USER',
        actorId: ctx.session.id,
        action: AUDIT_ACTIONS.ADDRESS_DELETE,
        targetId: deleted.id,
        after: { addressId: deleted.id },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      },
      tx,
    )

    return deleted
  },
)
