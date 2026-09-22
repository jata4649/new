import { describe, expect, it } from 'vitest'

import { PointTxType, PointType } from '@/generated/prisma/enums.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * DB レベルの不変条件が本当に効いているかを検証する。
 *
 * これらはアプリのバグや運用ミスに対する最後の砦であり、
 * 「アプリ側のチェックを忘れても DB が拒否する」ことを保証するもの。
 * マイグレーション（20260922000002_guards）が適用されていないと落ちる。
 */

async function createUser(email: string) {
  return testPrisma.user.create({
    data: {
      email,
      passwordHash: 'dummy-hash-for-test',
      pointAccount: { create: {} },
    },
    include: { pointAccount: true },
  })
}

describe('追記専用テーブルの保護', () => {
  it('監査ログを UPDATE できない', async () => {
    const log = await testPrisma.auditLog.create({
      data: { actorType: 'SYSTEM', action: 'TEST_ACTION' },
    })

    await expect(
      testPrisma.auditLog.update({
        where: { id: log.id },
        data: { action: 'TAMPERED' },
      }),
    ).rejects.toThrow(/APPEND_ONLY_VIOLATION/)
  })

  it('監査ログを DELETE できない', async () => {
    const log = await testPrisma.auditLog.create({
      data: { actorType: 'SYSTEM', action: 'TEST_ACTION' },
    })

    await expect(testPrisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow(
      /APPEND_ONLY_VIOLATION/,
    )
  })

  it('ポイント台帳を UPDATE できない（金額の書き換えを防ぐ）', async () => {
    const user = await createUser('ledger-immutable@example.test')
    const entry = await testPrisma.pointLedgerEntry.create({
      data: {
        userId: user.id,
        txType: PointTxType.PURCHASE,
        pointType: PointType.PAID,
        amount: 1_000,
        balanceAfter: 1_000,
      },
    })

    await expect(
      testPrisma.pointLedgerEntry.update({
        where: { id: entry.id },
        data: { amount: 999_999 },
      }),
    ).rejects.toThrow(/APPEND_ONLY_VIOLATION/)
  })

  it('抽選履歴を DELETE できない', async () => {
    const user = await createUser('draw-immutable@example.test')
    const ledger = await testPrisma.pointLedgerEntry.create({
      data: {
        userId: user.id,
        txType: PointTxType.DRAW,
        pointType: PointType.PAID,
        amount: -500,
        balanceAfter: 0,
      },
    })
    const campaign = await testPrisma.oripaCampaign.create({
      data: {
        slug: 'test-campaign',
        name: 'テストオリパ',
        pricePoints: 500,
        totalSlots: 10,
        remainingSlots: 10,
        salesStartAt: new Date('2026-01-01T00:00:00Z'),
        salesEndAt: new Date('2026-12-31T00:00:00Z'),
      },
    })
    const drawTx = await testPrisma.drawTransaction.create({
      data: {
        userId: user.id,
        campaignId: campaign.id,
        drawCount: 1,
        unitPricePoints: 500,
        totalPricePoints: 500,
        ledgerEntryId: ledger.id,
      },
    })

    await expect(
      testPrisma.drawTransaction.delete({ where: { id: drawTx.id } }),
    ).rejects.toThrow(/APPEND_ONLY_VIOLATION/)
  })
})

describe('CHECK 制約', () => {
  it('ポイント残高をマイナスにできない', async () => {
    const user = await createUser('negative-balance@example.test')

    await expect(
      testPrisma.pointAccount.update({
        where: { userId: user.id },
        data: { paidBalance: -1 },
      }),
    ).rejects.toThrow()
  })

  it('ロット残高が発行額を超えられない', async () => {
    const user = await createUser('lot-overflow@example.test')

    await expect(
      testPrisma.pointLot.create({
        data: {
          userId: user.id,
          pointType: PointType.PAID,
          amountIssued: 100,
          amountRemaining: 200,
          expiresAt: new Date('2026-12-31T00:00:00Z'),
          sourceType: PointTxType.PURCHASE,
        },
      }),
    ).rejects.toThrow()
  })

  it('理由なしの ADJUSTMENT を記帳できない', async () => {
    const user = await createUser('adjust-no-reason@example.test')

    await expect(
      testPrisma.pointLedgerEntry.create({
        data: {
          userId: user.id,
          txType: PointTxType.ADJUSTMENT,
          pointType: PointType.FREE,
          amount: 100,
          balanceAfter: 100,
        },
      }),
    ).rejects.toThrow()
  })

  it('理由つきの ADJUSTMENT は記帳できる', async () => {
    const user = await createUser('adjust-with-reason@example.test')

    const entry = await testPrisma.pointLedgerEntry.create({
      data: {
        userId: user.id,
        txType: PointTxType.ADJUSTMENT,
        pointType: PointType.FREE,
        amount: 100,
        balanceAfter: 100,
        reason: '問い合わせ対応による補填（チケット #123）',
      },
    })

    expect(entry.reason).toContain('#123')
  })

  it('金額 0 の記帳を拒否する', async () => {
    const user = await createUser('zero-amount@example.test')

    await expect(
      testPrisma.pointLedgerEntry.create({
        data: {
          userId: user.id,
          txType: PointTxType.BONUS,
          pointType: PointType.FREE,
          amount: 0,
          balanceAfter: 0,
        },
      }),
    ).rejects.toThrow()
  })

  it('メールアドレスを大文字のまま保存できない', async () => {
    await expect(
      testPrisma.user.create({
        data: { email: 'MixedCase@Example.test', passwordHash: 'dummy' },
      }),
    ).rejects.toThrow()
  })

  it('販売終了が販売開始より前のオリパを作れない', async () => {
    await expect(
      testPrisma.oripaCampaign.create({
        data: {
          slug: 'invalid-period',
          name: '期間が逆転したオリパ',
          pricePoints: 500,
          totalSlots: 10,
          remainingSlots: 10,
          salesStartAt: new Date('2026-12-31T00:00:00Z'),
          salesEndAt: new Date('2026-01-01T00:00:00Z'),
        },
      }),
    ).rejects.toThrow()
  })

  it('1 口価格を 0 にできない', async () => {
    await expect(
      testPrisma.oripaCampaign.create({
        data: {
          slug: 'zero-price',
          name: '無料オリパ',
          pricePoints: 0,
          totalSlots: 10,
          remainingSlots: 10,
          salesStartAt: new Date('2026-01-01T00:00:00Z'),
          salesEndAt: new Date('2026-12-31T00:00:00Z'),
        },
      }),
    ).rejects.toThrow()
  })

  it('残り口数が総口数を超えられない', async () => {
    await expect(
      testPrisma.oripaCampaign.create({
        data: {
          slug: 'remaining-overflow',
          name: '残り口数が多すぎるオリパ',
          pricePoints: 500,
          totalSlots: 10,
          remainingSlots: 11,
          salesStartAt: new Date('2026-01-01T00:00:00Z'),
          salesEndAt: new Date('2026-12-31T00:00:00Z'),
        },
      }),
    ).rejects.toThrow()
  })

  it('抽選の合計金額が単価 × 口数と一致しないと記録できない', async () => {
    const user = await createUser('draw-price-mismatch@example.test')
    const ledger = await testPrisma.pointLedgerEntry.create({
      data: {
        userId: user.id,
        txType: PointTxType.DRAW,
        pointType: PointType.PAID,
        amount: -100,
        balanceAfter: 0,
      },
    })
    const campaign = await testPrisma.oripaCampaign.create({
      data: {
        slug: 'price-check',
        name: '価格検証用',
        pricePoints: 500,
        totalSlots: 10,
        remainingSlots: 10,
        salesStartAt: new Date('2026-01-01T00:00:00Z'),
        salesEndAt: new Date('2026-12-31T00:00:00Z'),
      },
    })

    await expect(
      testPrisma.drawTransaction.create({
        data: {
          userId: user.id,
          campaignId: campaign.id,
          drawCount: 10,
          unitPricePoints: 500,
          // 本来は 5000。割引を勝手に適用するようなバグを DB で弾く。
          totalPricePoints: 100,
          ledgerEntryId: ledger.id,
        },
      }),
    ).rejects.toThrow()
  })
})

describe('一意制約', () => {
  it('同一決済からポイントを二重付与できない（INV-9）', async () => {
    const user = await createUser('double-grant@example.test')

    await testPrisma.pointLedgerEntry.create({
      data: {
        userId: user.id,
        txType: PointTxType.PURCHASE,
        pointType: PointType.PAID,
        amount: 1_000,
        balanceAfter: 1_000,
        sourceType: 'PAYMENT_TRANSACTION',
        sourceId: 'pay_123',
      },
    })

    await expect(
      testPrisma.pointLedgerEntry.create({
        data: {
          userId: user.id,
          txType: PointTxType.PURCHASE,
          pointType: PointType.PAID,
          amount: 1_000,
          balanceAfter: 2_000,
          sourceType: 'PAYMENT_TRANSACTION',
          sourceId: 'pay_123',
        },
      }),
    ).rejects.toThrow()
  })

  it('ソースを持たない記帳は何件でも作れる（NULL 同士は衝突しない）', async () => {
    const user = await createUser('null-source@example.test')

    for (let i = 0; i < 3; i++) {
      await testPrisma.pointLedgerEntry.create({
        data: {
          userId: user.id,
          txType: PointTxType.BONUS,
          pointType: PointType.FREE,
          amount: 10,
          balanceAfter: 10 * (i + 1),
        },
      })
    }

    const count = await testPrisma.pointLedgerEntry.count({ where: { userId: user.id } })
    expect(count).toBe(3)
  })

  it('同一ユーザー・同一スコープで冪等性キーを重複登録できない', async () => {
    const user = await createUser('idem-key@example.test')
    const payload = {
      userId: user.id,
      scope: 'draw',
      key: 'client-generated-key-1',
      requestHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000),
    }

    await testPrisma.idempotencyKey.create({ data: payload })
    await expect(testPrisma.idempotencyKey.create({ data: payload })).rejects.toThrow()
  })
})

describe('物理在庫の重複割当防止（INV-5）', () => {
  it('同じ在庫を 2 つのスロットへ割り当てられない', async () => {
    const inventory = await testPrisma.inventory.create({
      data: {
        code: 'INV-DUP-001',
        cardTitle: '架空タイトル',
        cardName: '架空カード',
        exchangePoints: 100,
      },
    })

    const campaign = await testPrisma.oripaCampaign.create({
      data: {
        slug: 'dup-alloc',
        name: '重複割当の検証',
        pricePoints: 500,
        totalSlots: 2,
        remainingSlots: 2,
        salesStartAt: new Date('2026-01-01T00:00:00Z'),
        salesEndAt: new Date('2026-12-31T00:00:00Z'),
        tiers: {
          create: { code: 'A', name: 'A賞', effectTier: 'GOLD', slotCount: 2, displayOrder: 1 },
        },
      },
      include: { tiers: true },
    })

    const tier = campaign.tiers[0]
    if (!tier) throw new Error('ティアの作成に失敗しました')

    await testPrisma.oripaSlot.create({
      data: {
        campaignId: campaign.id,
        slotNumber: 1,
        drawOrder: 1,
        inventoryId: inventory.id,
        tierId: tier.id,
        exchangePoints: 100,
      },
    })

    await expect(
      testPrisma.oripaSlot.create({
        data: {
          campaignId: campaign.id,
          slotNumber: 2,
          drawOrder: 2,
          inventoryId: inventory.id,
          tierId: tier.id,
          exchangePoints: 100,
        },
      }),
    ).rejects.toThrow()
  })

  it('物理在庫と汎用景品を同時に割り当てられない', async () => {
    const inventory = await testPrisma.inventory.create({
      data: {
        code: 'INV-EXCL-001',
        cardTitle: '架空タイトル',
        cardName: '架空カード',
        exchangePoints: 100,
      },
    })
    const generic = await testPrisma.genericPrize.create({
      data: { code: 'GEN-EXCL-001', name: '汎用景品', exchangePoints: 50 },
    })
    const campaign = await testPrisma.oripaCampaign.create({
      data: {
        slug: 'exclusive-source',
        name: '排他検証',
        pricePoints: 500,
        totalSlots: 1,
        remainingSlots: 1,
        salesStartAt: new Date('2026-01-01T00:00:00Z'),
        salesEndAt: new Date('2026-12-31T00:00:00Z'),
        tiers: {
          create: { code: 'A', name: 'A賞', effectTier: 'GOLD', slotCount: 1, displayOrder: 1 },
        },
      },
      include: { tiers: true },
    })
    const tier = campaign.tiers[0]
    if (!tier) throw new Error('ティアの作成に失敗しました')

    await expect(
      testPrisma.oripaSlot.create({
        data: {
          campaignId: campaign.id,
          slotNumber: 1,
          drawOrder: 1,
          inventoryId: inventory.id,
          genericPrizeId: generic.id,
          tierId: tier.id,
          exchangePoints: 100,
        },
      }),
    ).rejects.toThrow()
  })

  it('どちらも割り当てない空スロットも作れない', async () => {
    const campaign = await testPrisma.oripaCampaign.create({
      data: {
        slug: 'empty-slot',
        name: '空スロット検証',
        pricePoints: 500,
        totalSlots: 1,
        remainingSlots: 1,
        salesStartAt: new Date('2026-01-01T00:00:00Z'),
        salesEndAt: new Date('2026-12-31T00:00:00Z'),
        tiers: {
          create: { code: 'A', name: 'A賞', effectTier: 'GOLD', slotCount: 1, displayOrder: 1 },
        },
      },
      include: { tiers: true },
    })
    const tier = campaign.tiers[0]
    if (!tier) throw new Error('ティアの作成に失敗しました')

    await expect(
      testPrisma.oripaSlot.create({
        data: {
          campaignId: campaign.id,
          slotNumber: 1,
          drawOrder: 1,
          tierId: tier.id,
          exchangePoints: 0,
        },
      }),
    ).rejects.toThrow()
  })
})
