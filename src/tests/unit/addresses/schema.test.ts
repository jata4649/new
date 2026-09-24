import { describe, expect, it } from 'vitest'

import { addressInputSchema, addressUpdateSchema } from '@/modules/addresses/schema.ts'

/**
 * 配送先スキーマの単体テスト。
 *
 * 住所は「保存した形が 1 つに揃っていること」が後の突き合わせを左右する。
 * 入力の揺れをどこまで吸収し、どこから拒否するかをここで固定する。
 */

const VALID = {
  recipientName: '架空 太郎',
  postalCode: '150-0001',
  prefecture: '東京都',
  city: '渋谷区',
  addressLine1: '神南 1-2-3',
  phoneNumber: '09012345678',
}

describe('addressInputSchema: 郵便番号の正規化', () => {
  it('ハイフン無しを "123-4567" へ揃える', () => {
    const parsed = addressInputSchema.parse({ ...VALID, postalCode: '1500001' })
    expect(parsed.postalCode).toBe('150-0001')
  })

  it('ハイフン有りもそのまま "123-4567" になる', () => {
    const parsed = addressInputSchema.parse({ ...VALID, postalCode: '150-0001' })
    expect(parsed.postalCode).toBe('150-0001')
  })

  it('全角数字を半角へ寄せる', () => {
    const parsed = addressInputSchema.parse({ ...VALID, postalCode: '１５００００１' })
    expect(parsed.postalCode).toBe('150-0001')
  })

  it('前後の空白を落とす', () => {
    const parsed = addressInputSchema.parse({ ...VALID, postalCode: '  150-0001  ' })
    expect(parsed.postalCode).toBe('150-0001')
  })

  it('桁数が足りない・多い郵便番号を拒否する', () => {
    expect(addressInputSchema.safeParse({ ...VALID, postalCode: '150000' }).success).toBe(false)
    expect(addressInputSchema.safeParse({ ...VALID, postalCode: '15000012' }).success).toBe(
      false,
    )
  })

  it('数字以外を含む郵便番号を拒否する', () => {
    expect(addressInputSchema.safeParse({ ...VALID, postalCode: '150-000A' }).success).toBe(
      false,
    )
  })
})

describe('addressInputSchema: 電話番号の正規化', () => {
  it('ハイフン・空白・括弧を落として数字だけにする', () => {
    const parsed = addressInputSchema.parse({ ...VALID, phoneNumber: '090-1234-5678' })
    expect(parsed.phoneNumber).toBe('09012345678')
  })

  it('全角数字を半角へ寄せる', () => {
    const parsed = addressInputSchema.parse({ ...VALID, phoneNumber: '０９０１２３４５６７８' })
    expect(parsed.phoneNumber).toBe('09012345678')
  })

  it('固定電話（10 桁）も受理する', () => {
    const parsed = addressInputSchema.parse({ ...VALID, phoneNumber: '03-1234-5678' })
    expect(parsed.phoneNumber).toBe('0312345678')
  })

  it('0 で始まらない番号を拒否する', () => {
    expect(addressInputSchema.safeParse({ ...VALID, phoneNumber: '9012345678' }).success).toBe(
      false,
    )
  })

  it('桁数が範囲外の番号を拒否する', () => {
    expect(addressInputSchema.safeParse({ ...VALID, phoneNumber: '012345678' }).success).toBe(
      false,
    )
    expect(
      addressInputSchema.safeParse({ ...VALID, phoneNumber: '012345678901' }).success,
    ).toBe(false)
  })
})

describe('addressInputSchema: 都道府県', () => {
  it('47 都道府県のいずれかなら受理する', () => {
    expect(addressInputSchema.safeParse({ ...VALID, prefecture: '北海道' }).success).toBe(true)
    expect(addressInputSchema.safeParse({ ...VALID, prefecture: '沖縄県' }).success).toBe(true)
  })

  it('表記揺れを拒否する（自由入力にしない）', () => {
    expect(addressInputSchema.safeParse({ ...VALID, prefecture: '東京' }).success).toBe(false)
    expect(addressInputSchema.safeParse({ ...VALID, prefecture: 'とうきょう' }).success).toBe(
      false,
    )
    expect(addressInputSchema.safeParse({ ...VALID, prefecture: '' }).success).toBe(false)
  })
})

describe('addressInputSchema: そのほか', () => {
  it('必須項目が空なら拒否する', () => {
    expect(addressInputSchema.safeParse({ ...VALID, recipientName: '' }).success).toBe(false)
    expect(addressInputSchema.safeParse({ ...VALID, city: '' }).success).toBe(false)
    expect(addressInputSchema.safeParse({ ...VALID, addressLine1: '' }).success).toBe(false)
  })

  it('空白だけの必須項目も拒否する（trim してから長さを見る）', () => {
    expect(addressInputSchema.safeParse({ ...VALID, recipientName: '   ' }).success).toBe(false)
  })

  it('建物名は任意。空文字は null にする', () => {
    expect(addressInputSchema.parse(VALID).addressLine2).toBeNull()
    expect(addressInputSchema.parse({ ...VALID, addressLine2: '' }).addressLine2).toBeNull()
    expect(addressInputSchema.parse({ ...VALID, addressLine2: '101 号室' }).addressLine2).toBe(
      '101 号室',
    )
  })

  it('既定フラグは省略すると false', () => {
    expect(addressInputSchema.parse(VALID).isDefault).toBe(false)
  })

  it('宛名が長すぎれば拒否する', () => {
    expect(
      addressInputSchema.safeParse({ ...VALID, recipientName: 'あ'.repeat(65) }).success,
    ).toBe(false)
  })
})

describe('addressUpdateSchema', () => {
  it('一部だけの指定を許す（既定の切り替えだけを送れる）', () => {
    const parsed = addressUpdateSchema.parse({ isDefault: true })
    expect(parsed.isDefault).toBe(true)
    expect(parsed.recipientName).toBeUndefined()
  })

  it('指定した項目は新規と同じ検証を通る', () => {
    expect(addressUpdateSchema.safeParse({ postalCode: '150' }).success).toBe(false)
    expect(addressUpdateSchema.parse({ postalCode: '1500001' }).postalCode).toBe('150-0001')
  })
})
