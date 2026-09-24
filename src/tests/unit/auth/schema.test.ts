import { describe, expect, it } from 'vitest'

import { PASSWORD_MIN_LENGTH } from '@/modules/auth/password-policy.ts'
import { emailSchema, loginSchema, signupSchema } from '@/modules/auth/schema.ts'
import { updateUserStatusSchema, userListQuerySchema } from '@/modules/users/schema.ts'

describe('emailSchema', () => {
  it('小文字へ正規化する（DB の CHECK 制約と揃える）', () => {
    expect(emailSchema.parse('Foo.Bar@Example.COM')).toBe('foo.bar@example.com')
  })

  it('前後の空白を取り除く', () => {
    expect(emailSchema.parse('  user@example.test  ')).toBe('user@example.test')
  })

  it('形式が不正なら拒否する', () => {
    for (const invalid of ['', 'not-an-email', 'a@', '@example.com', 'a b@example.com']) {
      expect(emailSchema.safeParse(invalid).success, invalid).toBe(false)
    }
  })

  it('極端に長いアドレスを拒否する（DoS 対策）', () => {
    const long = `${'a'.repeat(250)}@example.com`
    expect(emailSchema.safeParse(long).success).toBe(false)
  })
})

describe('signupSchema', () => {
  const valid = {
    email: 'user@example.test',
    password: 'a'.repeat(PASSWORD_MIN_LENGTH),
    displayName: 'テスト太郎',
    acceptedTerms: true,
  }

  it('妥当な入力を受け入れる', () => {
    expect(signupSchema.safeParse(valid).success).toBe(true)
  })

  it('規約へ同意していないと登録できない', () => {
    const result = signupSchema.safeParse({ ...valid, acceptedTerms: false })
    expect(result.success).toBe(false)
  })

  it('パスワードが短すぎると拒否する', () => {
    const result = signupSchema.safeParse({
      ...valid,
      password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1),
    })
    expect(result.success).toBe(false)
  })

  it('パスワードが長すぎると拒否する（ハッシュ計算での DoS 対策）', () => {
    const result = signupSchema.safeParse({ ...valid, password: 'a'.repeat(200) })
    expect(result.success).toBe(false)
  })

  it('表示名が空なら拒否する', () => {
    expect(signupSchema.safeParse({ ...valid, displayName: '   ' }).success).toBe(false)
  })

  it('表示名の前後の空白を取り除く', () => {
    const result = signupSchema.parse({ ...valid, displayName: '  太郎  ' })
    expect(result.displayName).toBe('太郎')
  })
})

describe('loginSchema', () => {
  it('パスワードの長さは検証しない（既存ユーザーを締め出さないため）', () => {
    const result = loginSchema.safeParse({ email: 'a@example.test', password: 'x' })
    expect(result.success).toBe(true)
  })

  it('空のパスワードは拒否する', () => {
    expect(loginSchema.safeParse({ email: 'a@example.test', password: '' }).success).toBe(false)
  })
})

describe('updateUserStatusSchema', () => {
  it('理由なしでは変更できない', () => {
    expect(updateUserStatusSchema.safeParse({ status: 'SUSPENDED' }).success).toBe(false)
  })

  it('短すぎる理由を拒否する', () => {
    const result = updateUserStatusSchema.safeParse({ status: 'SUSPENDED', reason: 'だめ' })
    expect(result.success).toBe(false)
  })

  it('空白だけの理由を拒否する', () => {
    const result = updateUserStatusSchema.safeParse({
      status: 'SUSPENDED',
      reason: '          ',
    })
    expect(result.success).toBe(false)
  })

  it('妥当な理由つきなら受け入れる', () => {
    const result = updateUserStatusSchema.safeParse({
      status: 'SUSPENDED',
      reason: '規約違反の報告を受けたため',
    })
    expect(result.success).toBe(true)
  })

  it('未知のステータスを拒否する', () => {
    const result = updateUserStatusSchema.safeParse({
      status: 'DELETED',
      reason: '存在しないステータス',
    })
    expect(result.success).toBe(false)
  })
})

describe('userListQuerySchema', () => {
  it('既定値を埋める', () => {
    const result = userListQuerySchema.parse({})
    expect(result.page).toBe(1)
    expect(result.perPage).toBe(20)
  })

  it('クエリ文字列の数値を変換する', () => {
    const result = userListQuerySchema.parse({ page: '3', perPage: '50' })
    expect(result.page).toBe(3)
    expect(result.perPage).toBe(50)
  })

  it('perPage の上限を超える指定を拒否する（大量取得の防止）', () => {
    expect(userListQuerySchema.safeParse({ perPage: '1000' }).success).toBe(false)
  })

  it('page が 0 以下なら拒否する', () => {
    expect(userListQuerySchema.safeParse({ page: '0' }).success).toBe(false)
  })
})
