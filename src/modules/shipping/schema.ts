import { z } from 'zod'

import { ShippingStatus } from '@/generated/prisma/enums.ts'

/**
 * 発送の入力スキーマ。
 *
 * ■ まとめて申請できるようにする
 *   1 商品 1 発送にすると送料も梱包も利用者の手間も増える。
 *   複数の当選商品を 1 件の申請にまとめる。
 *
 * ■ 取り消せる範囲を入力の形で示す
 *   発送準備に入る前（REQUESTED / CHECKING）だけ取消しできる。
 *   判定はサーバーで行うが、理由を必須にすることで
 *   「誤操作で消えた」を記録上も区別できるようにする。
 */

/** 1 回の申請にまとめられる上限。梱包の実務が追える件数にとどめる。 */
export const MAX_ITEMS_PER_SHIPPING_REQUEST = 50

export const createShippingRequestSchema = z.object({
  /** 申請する当選商品。重複は受け付けない。 */
  prizeIds: z
    .array(z.string().min(1))
    .min(1, '発送する商品を選んでください')
    .max(
      MAX_ITEMS_PER_SHIPPING_REQUEST,
      `1 回に申請できるのは ${MAX_ITEMS_PER_SHIPPING_REQUEST} 件までです`,
    )
    .refine((ids) => new Set(ids).size === ids.length, {
      message: '同じ商品が重複しています',
    }),
  addressId: z.string().min(1, '配送先を選んでください'),
  /** 申請後は交換できなくなるため、確認の意思表示を要求する。 */
  confirm: z.literal(true, { message: '発送申請の確認が必要です' }),
})

export type CreateShippingRequestInput = z.infer<typeof createShippingRequestSchema>

export const cancelShippingRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, '取消しの理由を入力してください')
    .max(200, '理由は 200 文字以内で入力してください'),
})

export type CancelShippingRequestInput = z.infer<typeof cancelShippingRequestSchema>

export const shippingRequestIdParamsSchema = z.object({ id: z.string().min(1) })

/**
 * 管理者による状態更新。
 *
 * SHIPPED へ進めるときだけ配送業者と追跡番号を必須にする。
 * 「発送済みなのに追跡できない」状態を作らないため、
 * DB の CHECK（SHIPPED なら shipped_at 必須）に加えて入力でも縛る。
 */
export const updateShippingStatusSchema = z
  .object({
    status: z.enum([
      ShippingStatus.CHECKING,
      ShippingStatus.PACKING,
      ShippingStatus.SHIPPED,
      ShippingStatus.DELIVERED,
    ]),
    carrier: z.string().trim().max(64).optional(),
    trackingNumber: z.string().trim().max(64).optional(),
    adminNote: z.string().trim().max(500).optional(),
  })
  .refine(
    (value) =>
      value.status !== ShippingStatus.SHIPPED || (!!value.carrier && !!value.trackingNumber),
    {
      message: '発送済みにするには配送業者と追跡番号が必要です',
      path: ['trackingNumber'],
    },
  )

export type UpdateShippingStatusInput = z.infer<typeof updateShippingStatusSchema>

export const adminCancelShippingSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, '取消しの理由を入力してください')
    .max(200, '理由は 200 文字以内で入力してください'),
})

export const shipmentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(ShippingStatus).optional(),
})

export type ShipmentListQuery = z.infer<typeof shipmentListQuerySchema>

export const adminShipmentListQuerySchema = shipmentListQuerySchema.extend({
  userEmail: z.string().trim().max(254).optional(),
})

export type AdminShipmentListQuery = z.infer<typeof adminShipmentListQuerySchema>
