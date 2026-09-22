import { hash, verify } from '@node-rs/argon2'

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password-policy.ts'

/**
 * パスワードのハッシュ化。
 *
 * 要件: 「パスワードを平文保存しない」
 *
 * アルゴリズムは argon2id。パラメータは OWASP Password Storage Cheat Sheet の
 * 推奨値（memoryCost 19MiB / timeCost 2 / parallelism 1）に合わせている。
 *
 * argon2 のハッシュ文字列にはアルゴリズム・パラメータ・ソルトが含まれるため、
 * 将来パラメータを強化しても、既存ハッシュはそのまま検証できる
 * （ログイン成功時に再ハッシュする移行も可能）。
 */

const ARGON2_OPTIONS = {
  /** 19 MiB */
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  /** argon2id */
  algorithm: 2,
} as const

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH }

export async function hashPassword(plainPassword: string): Promise<string> {
  if (plainPassword.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`パスワードは ${PASSWORD_MIN_LENGTH} 文字以上にしてください`)
  }
  if (plainPassword.length > PASSWORD_MAX_LENGTH) {
    // 長すぎる入力による DoS を避ける
    throw new Error(`パスワードは ${PASSWORD_MAX_LENGTH} 文字以内にしてください`)
  }
  return hash(plainPassword, ARGON2_OPTIONS)
}

/**
 * パスワードを検証する。
 *
 * 検証失敗は例外ではなく false で返す。
 * 呼び出し側は「ユーザーが存在しない」場合との区別をユーザーへ見せないこと
 * （アカウント列挙を防ぐため、どちらも同じエラーメッセージにする）。
 */
export async function verifyPassword(
  passwordHash: string,
  plainPassword: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, plainPassword, ARGON2_OPTIONS)
  } catch {
    // ハッシュ文字列が壊れている場合など。認証は失敗扱いにする。
    return false
  }
}
