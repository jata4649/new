import { describe, expect, it } from 'vitest'

import {
  cancelShippingRequestSchema,
  createShippingRequestSchema,
  MAX_ITEMS_PER_SHIPPING_REQUEST,
  updateShippingStatusSchema,
} from '@/modules/shipping/schema.ts'

/**
 * 発送の入力スキーマの単体テスト。
 *
 * 発送申請はポイント交換への道を塞ぐ操作なので、
 * 「空リクエストで申請されていた」を成立させない。
 * 管理者の状態更新では「発送済みなのに追跡できない」を入力段階で止める。
 */

const VALID_REQUEST = {
  prizeIds: ['prize-1'],
  addressId: 'address-1',
  confirm: true as const,
}

describe('createShippingRequestSchema', () => {
  it('商品・配送先・確認が揃っていれば受理する', () => {
    expect(createShippingRequestSchema.safeParse(VALID_REQUEST).success).toBe(true)
  })

  it('confirm が無ければ拒否する', () => {
    const { confirm: _confirm, ...withoutConfirm } = VALID_REQUEST
    expect(createShippingRequestSchema.safeParse(withoutConfirm).success).toBe(false)
  })

  it('商品が 0 件なら拒否する', () => {
    expect(
      createShippingRequestSchema.safeParse({ ...VALID_REQUEST, prizeIds: [] }).success,
    ).toBe(false)
  })

  it('同じ商品が重複していれば拒否する（二重申請を入力段階で止める）', () => {
    const result = createShippingRequestSchema.safeParse({
      ...VALID_REQUEST,
      prizeIds: ['prize-1', 'prize-1'],
    })
    expect(result.success).toBe(false)
  })

  it('上限を超える件数を拒否する', () => {
    const tooMany = Array.from(
      { length: MAX_ITEMS_PER_SHIPPING_REQUEST + 1 },
      (_, index) => `prize-${index}`,
    )
    expect(
      createShippingRequestSchema.safeParse({ ...VALID_REQUEST, prizeIds: tooMany }).success,
    ).toBe(false)
  })

  it('上限ちょうどは受理する', () => {
    const exact = Array.from(
      { length: MAX_ITEMS_PER_SHIPPING_REQUEST },
      (_, index) => `prize-${index}`,
    )
    expect(
      createShippingRequestSchema.safeParse({ ...VALID_REQUEST, prizeIds: exact }).success,
    ).toBe(true)
  })

  it('配送先が空なら拒否する', () => {
    expect(
      createShippingRequestSchema.safeParse({ ...VALID_REQUEST, addressId: '' }).success,
    ).toBe(false)
  })
})

describe('cancelShippingRequestSchema', () => {
  it('理由があれば受理し、前後の空白を落とす', () => {
    const parsed = cancelShippingRequestSchema.parse({ reason: '  住所を間違えたため  ' })
    expect(parsed.reason).toBe('住所を間違えたため')
  })

  it('理由が無ければ拒否する', () => {
    expect(cancelShippingRequestSchema.safeParse({}).success).toBe(false)
  })

  it('空白だけの理由を拒否する', () => {
    expect(cancelShippingRequestSchema.safeParse({ reason: '   ' }).success).toBe(false)
  })

  it('長すぎる理由を拒否する', () => {
    expect(cancelShippingRequestSchema.safeParse({ reason: 'あ'.repeat(201) }).success).toBe(
      false,
    )
  })
})

describe('updateShippingStatusSchema', () => {
  it('検品・梱包へは追跡番号なしで進める', () => {
    expect(updateShippingStatusSchema.safeParse({ status: 'CHECKING' }).success).toBe(true)
    expect(updateShippingStatusSchema.safeParse({ status: 'PACKING' }).success).toBe(true)
  })

  it('発送済みには配送業者と追跡番号が要る', () => {
    expect(updateShippingStatusSchema.safeParse({ status: 'SHIPPED' }).success).toBe(false)
    expect(
      updateShippingStatusSchema.safeParse({ status: 'SHIPPED', carrier: 'ヤマト運輸' })
        .success,
    ).toBe(false)
    expect(
      updateShippingStatusSchema.safeParse({ status: 'SHIPPED', trackingNumber: '1234' })
        .success,
    ).toBe(false)
    expect(
      updateShippingStatusSchema.safeParse({
        status: 'SHIPPED',
        carrier: 'ヤマト運輸',
        trackingNumber: '1234567890',
      }).success,
    ).toBe(true)
  })

  it('取消しはこの経路では指定できない（別 API で理由必須にしている）', () => {
    expect(updateShippingStatusSchema.safeParse({ status: 'CANCELLED' }).success).toBe(false)
  })

  it('申請受付へ戻す指定はできない（巻き戻しを作らない）', () => {
    expect(updateShippingStatusSchema.safeParse({ status: 'REQUESTED' }).success).toBe(false)
  })

  it('未知の状態を拒否する', () => {
    expect(updateShippingStatusSchema.safeParse({ status: 'UNKNOWN' }).success).toBe(false)
  })
})
