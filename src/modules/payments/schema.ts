import { z } from 'zod'

import { PaymentStatus, PointTxType } from '@/generated/prisma/enums.ts'

/**
 * 決済・ポイント関連の入力スキーマ。
 *
 * 【重要】カード情報を受け取るフィールドは作らない。
 *   実在するカード番号を入力させない（テスト用であっても）。
 */

/** テスト決済で選べる金額。任意の値を許すと、意図しない大量ポイント発行につながる。 */
export const TEST_PAYMENT_AMOUNTS = [500, 1_000, 3_000, 5_000, 10_000] as const

export const createTestPaymentSchema = z.object({
  amountYen: z
    .number()
    .int()
    .refine(
      (value) => TEST_PAYMENT_AMOUNTS.includes(value as (typeof TEST_PAYMENT_AMOUNTS)[number]),
      {
        message: `金額は ${TEST_PAYMENT_AMOUNTS.join(' / ')} 円のいずれかを指定してください`,
      },
    ),
})

export type CreateTestPaymentInput = z.infer<typeof createTestPaymentSchema>

/**
 * テスト決済の状態を変更する。
 * 「決済成功」「失敗」「取消し」「返金」を再現するために使う。
 */
export const updateTestPaymentStatusSchema = z.object({
  status: z.enum([
    PaymentStatus.SUCCEEDED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
    PaymentStatus.REFUNDED,
  ]),
})

export const paymentIdParamsSchema = z.object({
  id: z.string().min(1),
})

/** Webhook 本文。署名検証を通ったうえで、さらに形を検証する。 */
export const mockWebhookSchema = z.object({
  eventId: z.string().min(1).max(200),
  eventType: z.string().min(1).max(100),
  providerPaymentId: z.string().min(1).max(200),
  status: z.enum(PaymentStatus),
  occurredAt: z.iso.datetime(),
})

export const pointHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  txType: z.enum(PointTxType).optional(),
})

export const adjustPointsSchema = z.object({
  amount: z
    .number()
    .int()
    .refine((value) => value !== 0, { message: '0 ポイントの調整はできません' })
    .refine((value) => Math.abs(value) <= 1_000_000, {
      message: '1 回の調整は 1,000,000 ポイント以内にしてください',
    }),
  reason: z
    .string()
    .trim()
    .min(5, '理由は 5 文字以上で入力してください')
    .max(500, '理由は 500 文字以内で入力してください'),
})

export type AdjustPointsInput = z.infer<typeof adjustPointsSchema>
