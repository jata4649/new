import { z } from 'zod'

import { UserStatus } from '@/generated/prisma/enums.ts'

/**
 * 管理画面のユーザー操作スキーマ。
 *
 * 要件: 「管理者がステータスを変更する場合、理由入力を必須にする」
 */

export const userListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  /** メールアドレス・表示名の部分一致 */
  q: z.string().trim().max(120).optional(),
  status: z.enum(UserStatus).optional(),
})

export type UserListQuery = z.infer<typeof userListQuerySchema>

/**
 * ステータス変更。
 * ACTIVE へ戻す場合も含め、理由の入力を必須にする
 * （「なぜ解除したか」も監査上は同じくらい重要なため）。
 */
export const updateUserStatusSchema = z.object({
  status: z.enum(UserStatus),
  reason: z
    .string()
    .trim()
    .min(5, '理由は 5 文字以上で入力してください')
    .max(500, '理由は 500 文字以内で入力してください'),
})

export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>

export const userIdParamsSchema = z.object({
  id: z.string().min(1),
})
