import { z } from 'zod'

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password-policy.ts'

/**
 * 認証まわりの入力スキーマ。
 *
 * 要件: 「入力値は Zod で検証する」
 *
 * メールアドレスは必ず小文字へ正規化する。
 * DB 側にも `email = lower(email)` の CHECK 制約があるため、
 * 正規化を忘れると保存時に失敗する（二重の防御）。
 */

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'メールアドレスを入力してください')
  .max(254, 'メールアドレスが長すぎます')
  .pipe(z.email('メールアドレスの形式が正しくありません'))
  .transform((value) => value.toLowerCase())

/**
 * パスワードの要件。
 * 長さを主軸にし、記号必須などの複雑な規則は課さない
 * （覚えられない規則は使い回しを招くため。OWASP の推奨に沿う）。
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `パスワードは ${PASSWORD_MIN_LENGTH} 文字以上にしてください`)
  .max(PASSWORD_MAX_LENGTH, `パスワードは ${PASSWORD_MAX_LENGTH} 文字以内にしてください`)

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, '表示名を入力してください')
  .max(32, '表示名は 32 文字以内にしてください')

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  /** 利用規約への同意。false では登録できない。 */
  acceptedTerms: z.literal(true, {
    message: '利用規約への同意が必要です',
  }),
})

export type SignupInput = z.infer<typeof signupSchema>

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'パスワードを入力してください'),
})

export type LoginInput = z.infer<typeof loginSchema>
