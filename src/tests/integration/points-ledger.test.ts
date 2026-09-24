import { beforeEach, describe, expect, it } from 'vitest'

import { PointTxType, PointType } from '@/generated/prisma/enums.ts'
import { AppError, ERROR_CODES } from '@/lib/api/errors.ts'
import { addDays, now, resetNowProvider, setNowProvider } from '@/lib/datetime/index.ts'
import {
  consumePoints,
  getBalance,
  grantPoints,
  reverseConsumption,
} from '@/modules/points/ledger.ts'
import { buildRequestHash, runIdempotent } from '@/lib/idempotency/index.ts'
import { adjustUserPoints } from '@/modules/points/admin.ts'
import { expirePoints } from '@/modules/points/expiry.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * ポイント台帳の統合テスト。
 *
 * このシステムで最も事故が起きやすい箇所なので、
 * 不変条件（docs/01-architecture.md §2）を 1 つずつ確認する。
 */

async function createUser(email = 'points@example.test') {
  const user = await testPrisma.user.create({
    data: {
      email,
      passwordHash: 'dummy-hash',
      profile: { create: { displayName: 'テスト' } },
      pointAccount: { create: {} },
    },
    select: { id: true },
  })
  return user.id
}

/**
 * すでに失効したロットを作る。
 *
 * DB の CHECK 制約により expires_at > issued_at が必須なので、
 * 「過去に発行し、その翌日に失効した」状態を時刻を巻き戻して作る。
 * 現実に起こる状態と同じ手順を踏むため、制約を回避せずに検証できる。
 */
async function grantAlreadyExpiredLot(
  userId: string,
  amount: number,
  pointType: PointType = PointType.FREE,
) {
  const past = addDays(now(), -10)
  setNowProvider(() => past)
  try {
    return await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount,
        pointType,
        txType: PointTxType.BONUS,
        expiresAt: addDays(past, 1),
      }),
    )
  } finally {
    resetNowProvider()
  }
}

/** 台帳の合計と口座キャッシュが一致することを確認する（INV-1） */
async function assertLedgerMatchesAccount(userId: string) {
  const entries = await testPrisma.pointLedgerEntry.findMany({
    where: { userId },
    select: { amount: true },
  })
  const ledgerTotal = entries.reduce((sum, entry) => sum + entry.amount, 0)

  const account = await testPrisma.pointAccount.findUnique({
    where: { userId },
    select: { paidBalance: true, freeBalance: true },
  })
  const accountTotal = (account?.paidBalance ?? 0) + (account?.freeBalance ?? 0)

  expect(accountTotal, 'INV-1: 台帳の合計と口座残高が一致すること').toBe(ledgerTotal)
}

/** ロット残高の合計と口座キャッシュが一致することを確認する（INV-2） */
async function assertLotsMatchAccount(userId: string) {
  const lots = await testPrisma.pointLot.findMany({
    where: { userId },
    select: { amountRemaining: true },
  })
  const lotTotal = lots.reduce((sum, lot) => sum + lot.amountRemaining, 0)

  const account = await testPrisma.pointAccount.findUnique({
    where: { userId },
    select: { paidBalance: true, freeBalance: true },
  })
  const accountTotal = (account?.paidBalance ?? 0) + (account?.freeBalance ?? 0)

  expect(accountTotal, 'INV-2: ロット残高の合計と口座残高が一致すること').toBe(lotTotal)
}

describe('grantPoints', () => {
  it('ロットを作り、台帳へ記帳し、残高を増やす', async () => {
    const userId = await createUser()

    const result = await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount: 1_000,
        pointType: PointType.PAID,
        txType: PointTxType.PURCHASE,
      }),
    )

    expect(result.amount).toBe(1_000)
    expect(result.balanceAfter).toBe(1_000)

    const lot = await testPrisma.pointLot.findUnique({ where: { id: result.lotId } })
    expect(lot?.amountIssued).toBe(1_000)
    expect(lot?.amountRemaining).toBe(1_000)

    await assertLedgerMatchesAccount(userId)
    await assertLotsMatchAccount(userId)
  })

  it('有償ポイントの有効期限は 180 日（資金決済法リスクの回避）', async () => {
    const userId = await createUser()
    const issuedAt = now()

    const result = await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount: 500,
        pointType: PointType.PAID,
        txType: PointTxType.PURCHASE,
      }),
    )

    const days = Math.round(
      (result.expiresAt.getTime() - issuedAt.getTime()) / (24 * 60 * 60 * 1000),
    )
    expect(days).toBe(180)
  })

  it('付与ごとに別のロットを作る（有効期限が混ざらないように）', async () => {
    const userId = await createUser()

    await testPrisma.$transaction(async (tx) => {
      await grantPoints(tx, {
        userId,
        amount: 100,
        pointType: PointType.FREE,
        txType: PointTxType.BONUS,
      })
      await grantPoints(tx, {
        userId,
        amount: 200,
        pointType: PointType.FREE,
        txType: PointTxType.BONUS,
      })
    })

    const lots = await testPrisma.pointLot.findMany({ where: { userId } })
    expect(lots).toHaveLength(2)
    await assertLotsMatchAccount(userId)
  })

  it('0 以下の付与を拒否する', async () => {
    const userId = await createUser()

    await expect(
      testPrisma.$transaction((tx) =>
        grantPoints(tx, {
          userId,
          amount: 0,
          pointType: PointType.FREE,
          txType: PointTxType.BONUS,
        }),
      ),
    ).rejects.toThrow()
  })

  it('ADJUSTMENT は理由が無ければ拒否する', async () => {
    const userId = await createUser()

    await expect(
      testPrisma.$transaction((tx) =>
        grantPoints(tx, {
          userId,
          amount: 100,
          pointType: PointType.FREE,
          txType: PointTxType.ADJUSTMENT,
        }),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      if (!AppError.isAppError(error)) return false
      expect(error.code).toBe(ERROR_CODES.REASON_REQUIRED)
      return true
    })
  })
})

describe('consumePoints（消費順序）', () => {
  let userId: string

  beforeEach(async () => {
    userId = await createUser()

    // 既定の消費順序（free_first）を検証するため、
    // 無償・有償それぞれに期限の異なるロットを用意する
    await testPrisma.$transaction(async (tx) => {
      await grantPoints(tx, {
        userId,
        amount: 300,
        pointType: PointType.FREE,
        txType: PointTxType.BONUS,
        expiresAt: addDays(now(), 10),
      })
      await grantPoints(tx, {
        userId,
        amount: 500,
        pointType: PointType.PAID,
        txType: PointTxType.PURCHASE,
        expiresAt: addDays(now(), 5),
      })
      await grantPoints(tx, {
        userId,
        amount: 1_000,
        pointType: PointType.PAID,
        txType: PointTxType.PURCHASE,
        expiresAt: addDays(now(), 60),
      })
    })
  })

  it('無償ポイントを先に消費する（既定: free_first）', async () => {
    const result = await testPrisma.$transaction((tx) =>
      consumePoints(tx, { userId, amount: 200, txType: PointTxType.DRAW }),
    )

    expect(result.freeConsumed).toBe(200)
    expect(result.paidConsumed).toBe(0)
    await assertLedgerMatchesAccount(userId)
    await assertLotsMatchAccount(userId)
  })

  it('無償を使い切った後は、有効期限が近い有償ポイントから消費する', async () => {
    // 無償 300 + 有償(期限5日) 500 = 800 を消費
    const result = await testPrisma.$transaction((tx) =>
      consumePoints(tx, { userId, amount: 800, txType: PointTxType.DRAW }),
    )

    expect(result.freeConsumed).toBe(300)
    expect(result.paidConsumed).toBe(500)

    // 期限が遠い 1,000 のロットは手つかず
    const remaining = await testPrisma.pointLot.findFirst({
      where: { userId, amountIssued: 1_000 },
      select: { amountRemaining: true },
    })
    expect(remaining?.amountRemaining).toBe(1_000)

    await assertLotsMatchAccount(userId)
  })

  it('複数ロットにまたがる消費では、明細を 1 件ずつ記録する', async () => {
    const result = await testPrisma.$transaction((tx) =>
      consumePoints(tx, { userId, amount: 900, txType: PointTxType.DRAW }),
    )

    expect(result.breakdown).toHaveLength(3)

    const consumptions = await testPrisma.pointLotConsumption.findMany({
      where: { ledgerEntryId: result.ledgerEntryId },
      select: { amount: true },
    })
    expect(consumptions).toHaveLength(3)
    expect(consumptions.reduce((sum, c) => sum + c.amount, 0)).toBe(900)
  })

  it('複数種別にまたがる記帳では pointType を null にする', async () => {
    const result = await testPrisma.$transaction((tx) =>
      consumePoints(tx, { userId, amount: 500, txType: PointTxType.DRAW }),
    )

    const entry = await testPrisma.pointLedgerEntry.findUnique({
      where: { id: result.ledgerEntryId },
      select: { pointType: true, amount: true },
    })
    expect(entry?.pointType).toBeNull()
    expect(entry?.amount).toBe(-500)
  })

  it('使い切ったロットに exhausted_at を記録する', async () => {
    await testPrisma.$transaction((tx) =>
      consumePoints(tx, { userId, amount: 300, txType: PointTxType.DRAW }),
    )

    const lot = await testPrisma.pointLot.findFirst({
      where: { userId, pointType: PointType.FREE },
      select: { amountRemaining: true, exhaustedAt: true },
    })
    expect(lot?.amountRemaining).toBe(0)
    expect(lot?.exhaustedAt).not.toBeNull()
  })
})

describe('consumePoints（残高不足）', () => {
  it('残高が足りなければ INSUFFICIENT_POINTS を投げ、何も変更しない', async () => {
    const userId = await createUser()
    await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount: 100,
        pointType: PointType.FREE,
        txType: PointTxType.BONUS,
      }),
    )

    await expect(
      testPrisma.$transaction((tx) =>
        consumePoints(tx, { userId, amount: 101, txType: PointTxType.DRAW }),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      if (!AppError.isAppError(error)) return false
      expect(error.code).toBe(ERROR_CODES.INSUFFICIENT_POINTS)
      return true
    })

    // 残高は減っていない
    const balance = await getBalance(testPrisma, userId)
    expect(balance.total).toBe(100)

    // 消費の記帳も作られていない
    const drawEntries = await testPrisma.pointLedgerEntry.count({
      where: { userId, txType: PointTxType.DRAW },
    })
    expect(drawEntries).toBe(0)

    await assertLedgerMatchesAccount(userId)
  })

  it('ちょうどの残高なら消費できる', async () => {
    const userId = await createUser()
    await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount: 500,
        pointType: PointType.PAID,
        txType: PointTxType.PURCHASE,
      }),
    )

    await testPrisma.$transaction((tx) =>
      consumePoints(tx, { userId, amount: 500, txType: PointTxType.DRAW }),
    )

    const balance = await getBalance(testPrisma, userId)
    expect(balance.total).toBe(0)
    await assertLotsMatchAccount(userId)
  })

  it('期限切れのポイントは残高に数えない（失効バッチ未実行でも使えない）', async () => {
    const userId = await createUser()

    await grantAlreadyExpiredLot(userId, 1_000)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.total).toBe(0)

    await expect(
      testPrisma.$transaction((tx) =>
        consumePoints(tx, { userId, amount: 1, txType: PointTxType.DRAW }),
      ),
    ).rejects.toThrow()
  })
})

describe('reverseConsumption', () => {
  it('消費を取り消し、元のロットへ戻す（有効期限は元のまま）', async () => {
    const userId = await createUser()
    const expiresAt = addDays(now(), 30)

    await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount: 1_000,
        pointType: PointType.PAID,
        txType: PointTxType.PURCHASE,
        expiresAt,
      }),
    )

    const consumed = await testPrisma.$transaction((tx) =>
      consumePoints(tx, { userId, amount: 400, txType: PointTxType.DRAW }),
    )

    const reversed = await testPrisma.$transaction((tx) =>
      reverseConsumption(tx, {
        ledgerEntryId: consumed.ledgerEntryId,
        txType: PointTxType.REVERSAL,
        reason: '抽選の取消しによる返却',
      }),
    )

    expect(reversed.restored).toBe(400)
    expect(reversed.unrestorable).toBe(0)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.total).toBe(1_000)

    // 元のロットへ戻っており、期限も変わっていない
    const lot = await testPrisma.pointLot.findFirst({
      where: { userId },
      select: { amountRemaining: true, expiresAt: true },
    })
    expect(lot?.amountRemaining).toBe(1_000)
    expect(lot?.expiresAt.getTime()).toBe(expiresAt.getTime())

    await assertLedgerMatchesAccount(userId)
    await assertLotsMatchAccount(userId)
  })

  it('理由なしの取消しは拒否する', async () => {
    const userId = await createUser()
    await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount: 100,
        pointType: PointType.FREE,
        txType: PointTxType.BONUS,
      }),
    )
    const consumed = await testPrisma.$transaction((tx) =>
      consumePoints(tx, { userId, amount: 100, txType: PointTxType.DRAW }),
    )

    await expect(
      testPrisma.$transaction((tx) =>
        reverseConsumption(tx, {
          ledgerEntryId: consumed.ledgerEntryId,
          txType: PointTxType.REVERSAL,
          reason: '   ',
        }),
      ),
    ).rejects.toThrow()
  })

  it('付与の記帳は取り消せない（消費だけが対象）', async () => {
    const userId = await createUser()
    const granted = await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount: 100,
        pointType: PointType.FREE,
        txType: PointTxType.BONUS,
      }),
    )

    await expect(
      testPrisma.$transaction((tx) =>
        reverseConsumption(tx, {
          ledgerEntryId: granted.ledgerEntryId,
          txType: PointTxType.REVERSAL,
          reason: '誤った取消しの試行',
        }),
      ),
    ).rejects.toThrow()
  })
})

describe('expirePoints', () => {
  it('期限切れロットを失効させ、台帳へ記帳する', async () => {
    const userId = await createUser()

    await grantAlreadyExpiredLot(userId, 300)
    await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount: 700,
        pointType: PointType.PAID,
        txType: PointTxType.PURCHASE,
        expiresAt: addDays(now(), 30),
      }),
    )

    const result = await expirePoints()

    expect(result.processedLots).toBe(1)
    expect(result.expiredPoints).toBe(300)
    expect(result.affectedUsers).toBe(1)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.total).toBe(700)

    const expireEntry = await testPrisma.pointLedgerEntry.findFirst({
      where: { userId, txType: PointTxType.EXPIRE },
      select: { amount: true, balanceAfter: true },
    })
    expect(expireEntry?.amount).toBe(-300)
    expect(expireEntry?.balanceAfter).toBe(700)

    await assertLedgerMatchesAccount(userId)
    await assertLotsMatchAccount(userId)
  })

  it('同じロットを二重に失効させない（再実行しても安全）', async () => {
    const userId = await createUser()
    await grantAlreadyExpiredLot(userId, 500)

    await expirePoints()
    const second = await expirePoints()

    expect(second.processedLots).toBe(0)
    expect(second.expiredPoints).toBe(0)

    const expireEntries = await testPrisma.pointLedgerEntry.count({
      where: { userId, txType: PointTxType.EXPIRE },
    })
    expect(expireEntries).toBe(1)

    await assertLedgerMatchesAccount(userId)
  })

  it('期限切れが無ければ何もしない', async () => {
    const userId = await createUser()
    await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount: 100,
        pointType: PointType.FREE,
        txType: PointTxType.BONUS,
      }),
    )

    const result = await expirePoints()
    expect(result.processedLots).toBe(0)
  })

  it('開発用の期限短縮が効く（時刻を進めて確認）', async () => {
    const userId = await createUser()

    await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount: 100,
        pointType: PointType.FREE,
        txType: PointTxType.BONUS,
        expiresAt: addDays(now(), 1),
      }),
    )

    // 2 日後へ進める
    const future = addDays(now(), 2)
    setNowProvider(() => future)
    try {
      const result = await expirePoints()
      expect(result.expiredPoints).toBe(100)
    } finally {
      resetNowProvider()
    }
  })
})

describe('管理者によるポイント調整', () => {
  async function createAdmin() {
    const admin = await testPrisma.user.create({
      data: {
        email: 'admin-adjust@example.test',
        passwordHash: 'dummy-hash',
        role: 'ADMIN',
        profile: { create: { displayName: '管理者' } },
        pointAccount: { create: {} },
      },
      select: { id: true },
    })
    return admin.id
  }

  it('付与を台帳へ ADJUSTMENT として記帳する', async () => {
    const adminId = await createAdmin()
    const userId = await createUser('adjust-target@example.test')

    const result = await testPrisma.$transaction((tx) =>
      adjustUserPoints(
        tx,
        {
          userId,
          amount: 500,
          reason: '問い合わせ対応による補填',
          requestId: 'req-1',
        },
        { id: adminId },
      ),
    )

    expect(result.balanceAfter).toBe(500)

    const entry = await testPrisma.pointLedgerEntry.findFirst({
      where: { userId, txType: PointTxType.ADJUSTMENT },
      select: { amount: true, reason: true, createdBy: true, pointType: true },
    })
    expect(entry?.amount).toBe(500)
    expect(entry?.reason).toBe('問い合わせ対応による補填')
    expect(entry?.createdBy, '実行者が記録される').toBe(adminId)
    // 対価の裏付けが無いため無償ポイントとして発行する
    expect(entry?.pointType).toBe(PointType.FREE)

    await assertLedgerMatchesAccount(userId)
  })

  it('同じ管理者が何度でも調整できる（台帳の一意制約に引っかからない）', async () => {
    const adminId = await createAdmin()
    const first = await createUser('target-1@example.test')
    const second = await createUser('target-2@example.test')

    await testPrisma.$transaction((tx) =>
      adjustUserPoints(
        tx,
        { userId: first, amount: 100, reason: '1 回目の調整', requestId: 'req-a' },
        { id: adminId },
      ),
    )

    // sourceId に実行者 ID を入れていると、ここで一意制約違反になる
    await testPrisma.$transaction((tx) =>
      adjustUserPoints(
        tx,
        { userId: second, amount: 200, reason: '2 回目の調整', requestId: 'req-b' },
        { id: adminId },
      ),
    )

    // 同じユーザーへの 2 回目も通る
    await testPrisma.$transaction((tx) =>
      adjustUserPoints(
        tx,
        { userId: first, amount: 300, reason: '3 回目の調整', requestId: 'req-c' },
        { id: adminId },
      ),
    )

    const adjustments = await testPrisma.pointLedgerEntry.count({
      where: { txType: PointTxType.ADJUSTMENT },
    })
    expect(adjustments).toBe(3)

    expect((await getBalance(testPrisma, first)).total).toBe(400)
    expect((await getBalance(testPrisma, second)).total).toBe(200)
  })

  it('減額もできる（残高不足なら拒否する）', async () => {
    const adminId = await createAdmin()
    const userId = await createUser('adjust-minus@example.test')

    await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount: 300,
        pointType: PointType.FREE,
        txType: PointTxType.BONUS,
      }),
    )

    await testPrisma.$transaction((tx) =>
      adjustUserPoints(
        tx,
        { userId, amount: -100, reason: '誤付与の取消し', requestId: 'req-minus' },
        { id: adminId },
      ),
    )

    expect((await getBalance(testPrisma, userId)).total).toBe(200)

    await expect(
      testPrisma.$transaction((tx) =>
        adjustUserPoints(
          tx,
          { userId, amount: -1_000, reason: '残高を超える減算', requestId: 'req-over' },
          { id: adminId },
        ),
      ),
    ).rejects.toThrow()

    expect((await getBalance(testPrisma, userId)).total, '残高は変わらない').toBe(200)
  })

  it('理由が空なら拒否する', async () => {
    const adminId = await createAdmin()
    const userId = await createUser('adjust-noreason@example.test')

    await expect(
      testPrisma.$transaction((tx) =>
        adjustUserPoints(
          tx,
          { userId, amount: 100, reason: '   ', requestId: 'req-x' },
          { id: adminId },
        ),
      ),
    ).rejects.toThrow()
  })
})

describe('冪等性ラッパのエラー識別', () => {
  it('冪等性キー以外の一意制約違反を「重複リクエスト」と誤認しない', async () => {
    const userId = await createUser('idem-misclassify@example.test')

    // 業務処理の中で別の一意制約違反を起こす。
    // これを REQUEST_IN_PROGRESS に丸めると、本当のバグが隠れてしまう。
    await expect(
      runIdempotent(
        {
          userId,
          scope: 'test',
          key: 'unique-key-1',
          requestHash: buildRequestHash({ a: 1 }),
        },
        async (tx) => {
          await tx.user.create({
            data: {
              // すでに存在するメールアドレス
              email: 'idem-misclassify@example.test',
              passwordHash: 'dummy',
            },
          })
          return { ok: true }
        },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      // AppError ではなく、元の Prisma エラーがそのまま伝わること
      expect(AppError.isAppError(error)).toBe(false)
      expect(String(error)).toContain('Unique constraint')
      return true
    })
  })
})
