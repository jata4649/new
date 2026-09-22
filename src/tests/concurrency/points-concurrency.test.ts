import { describe, expect, it } from 'vitest'

import { PaymentStatus, PointTxType, PointType } from '@/generated/prisma/enums.ts'
import { addDays, now } from '@/lib/datetime/index.ts'
import { buildRequestHash, runIdempotent } from '@/lib/idempotency/index.ts'
import {
  getPaymentProvider,
  MOCK_EVENT_ID_HEADER,
  MOCK_SIGNATURE_HEADER,
  signPayload,
} from '@/modules/payments/mock-provider.ts'
import {
  applyPaymentStatus,
  createTestPayment,
  handleWebhook,
} from '@/modules/payments/service.ts'
import { consumePoints, getBalance, grantPoints } from '@/modules/points/ledger.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * 同時実行テスト。
 *
 * 要件で明示されているケースのうち、Phase 3 の範囲を検証する。
 *  - 同じ冪等性キーを複数回送信
 *  - 同じ決済 Webhook の同時受信
 *  - 残高ちょうどのポイントを同時に消費
 *
 * 「残り 1 口への同時抽選」「同じ商品の同時交換」は Phase 5・6 で追加する。
 *
 * このプロジェクトは単一ワーカー・直列実行（vitest.config.ts）。
 * テスト内では Promise.allSettled で本当に並行させる。
 */

async function createUser(email: string) {
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

function countFulfilled(results: PromiseSettledResult<unknown>[]): number {
  return results.filter((r) => r.status === 'fulfilled').length
}

describe('ポイント消費の同時実行', () => {
  it('残高ちょうどを 5 並列で消費しても、成功するのは 1 件だけ', async () => {
    const userId = await createUser('concurrent-consume@example.test')

    await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount: 500,
        pointType: PointType.PAID,
        txType: PointTxType.PURCHASE,
      }),
    )

    const attempts = Array.from({ length: 5 }, () =>
      testPrisma.$transaction((tx) =>
        consumePoints(tx, { userId, amount: 500, txType: PointTxType.DRAW }),
      ),
    )

    const results = await Promise.allSettled(attempts)

    expect(countFulfilled(results), '成功は 1 件だけ').toBe(1)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.total, '残高がマイナスになっていない').toBe(0)

    const drawEntries = await testPrisma.pointLedgerEntry.count({
      where: { userId, txType: PointTxType.DRAW },
    })
    expect(drawEntries, '記帳も 1 件だけ').toBe(1)
  })

  it('並行して消費しても、台帳の合計と残高が一致する（INV-1）', async () => {
    const userId = await createUser('concurrent-ledger@example.test')

    await testPrisma.$transaction((tx) =>
      grantPoints(tx, {
        userId,
        amount: 1_000,
        pointType: PointType.PAID,
        txType: PointTxType.PURCHASE,
      }),
    )

    // 100 ポイントの消費を 15 並列。10 件成功し、5 件は残高不足になるはず。
    const attempts = Array.from({ length: 15 }, () =>
      testPrisma.$transaction((tx) =>
        consumePoints(tx, { userId, amount: 100, txType: PointTxType.DRAW }),
      ),
    )
    const results = await Promise.allSettled(attempts)

    expect(countFulfilled(results)).toBe(10)

    const entries = await testPrisma.pointLedgerEntry.findMany({
      where: { userId },
      select: { amount: true },
    })
    const ledgerTotal = entries.reduce((sum, entry) => sum + entry.amount, 0)

    const account = await testPrisma.pointAccount.findUnique({
      where: { userId },
      select: { paidBalance: true, freeBalance: true },
    })

    expect((account?.paidBalance ?? 0) + (account?.freeBalance ?? 0)).toBe(ledgerTotal)
    expect(ledgerTotal).toBe(0)
  })

  it('別ユーザー同士の消費は互いをブロックしない', async () => {
    const first = await createUser('user-a@example.test')
    const second = await createUser('user-b@example.test')

    for (const userId of [first, second]) {
      await testPrisma.$transaction((tx) =>
        grantPoints(tx, {
          userId,
          amount: 500,
          pointType: PointType.FREE,
          txType: PointTxType.BONUS,
        }),
      )
    }

    const results = await Promise.allSettled([
      testPrisma.$transaction((tx) =>
        consumePoints(tx, { userId: first, amount: 500, txType: PointTxType.DRAW }),
      ),
      testPrisma.$transaction((tx) =>
        consumePoints(tx, { userId: second, amount: 500, txType: PointTxType.DRAW }),
      ),
    ])

    expect(countFulfilled(results), '両方とも成功する').toBe(2)
  })
})

describe('冪等性キーの同時送信', () => {
  it('同じキーを 5 並列で送っても、業務処理は 1 回だけ実行される', async () => {
    const userId = await createUser('idempotent@example.test')

    const key = 'same-key-for-all'
    const requestHash = buildRequestHash({ amount: 1_000 })

    let executionCount = 0

    const attempts = Array.from({ length: 5 }, () =>
      runIdempotent({ userId, scope: 'test', key, requestHash }, async (tx) => {
        executionCount++
        const grant = await grantPoints(tx, {
          userId,
          amount: 1_000,
          pointType: PointType.FREE,
          txType: PointTxType.BONUS,
        })
        return { ledgerEntryId: grant.ledgerEntryId }
      }),
    )

    const results = await Promise.allSettled(attempts)

    // 先行がコミットする前に届いたものは REQUEST_IN_PROGRESS で失敗しうる。
    // 重要なのは「業務処理が 1 回しか実行されないこと」。
    expect(executionCount, '業務処理の実行は 1 回だけ').toBe(1)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.total, 'ポイントも 1 回だけ付与される').toBe(1_000)

    const lots = await testPrisma.pointLot.count({ where: { userId } })
    expect(lots).toBe(1)

    // 成功したものはすべて同じ結果を返す
    const ids = new Set(
      results.filter((r) => r.status === 'fulfilled').map((r) => r.value.data.ledgerEntryId),
    )
    expect(ids.size, 'すべて同じレスポンスを返す').toBe(1)
  })

  it('順番に送った場合はリプレイになり、二重実行されない', async () => {
    const userId = await createUser('idempotent-serial@example.test')

    const key = 'serial-key'
    const requestHash = buildRequestHash({ amount: 500 })
    let executionCount = 0

    const work = () =>
      runIdempotent({ userId, scope: 'test', key, requestHash }, async (tx) => {
        executionCount++
        const grant = await grantPoints(tx, {
          userId,
          amount: 500,
          pointType: PointType.FREE,
          txType: PointTxType.BONUS,
        })
        return { ledgerEntryId: grant.ledgerEntryId }
      })

    const first = await work()
    const second = await work()

    expect(executionCount).toBe(1)
    expect(first.replayed).toBe(false)
    expect(second.replayed, '2 回目はリプレイ').toBe(true)
    expect(second.data.ledgerEntryId).toBe(first.data.ledgerEntryId)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.total).toBe(500)
  })
})

describe('決済 Webhook の同時受信', () => {
  async function createPayment(userId: string, amountYen = 1_000) {
    const key = await testPrisma.idempotencyKey.create({
      data: {
        userId,
        scope: 'test_payment',
        key: `key-${Math.random()}`,
        requestHash: 'h',
        expiresAt: addDays(now(), 1),
      },
      select: { id: true },
    })
    return testPrisma.$transaction((tx) => createTestPayment(tx, { userId, amountYen }, key.id))
  }

  function buildSignedWebhook(providerPaymentId: string, eventId: string) {
    const body = JSON.stringify({
      eventId,
      eventType: 'payment.updated',
      providerPaymentId,
      status: PaymentStatus.SUCCEEDED,
      occurredAt: now().toISOString(),
    })
    const headers = new Headers({
      [MOCK_SIGNATURE_HEADER]: signPayload(body),
      [MOCK_EVENT_ID_HEADER]: eventId,
    })
    return { body, headers }
  }

  it('同じ Webhook を 5 並列で受信してもポイントは 1 回だけ付与される', async () => {
    const userId = await createUser('webhook-concurrent@example.test')
    const payment = await createPayment(userId, 1_000)

    const { body, headers } = buildSignedWebhook(payment.providerPaymentId, 'evt_same')
    const verification = getPaymentProvider().verifyWebhook(body, headers)

    const attempts = Array.from({ length: 5 }, () =>
      handleWebhook(verification, JSON.parse(body)),
    )
    await Promise.allSettled(attempts)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.paid, '二重付与されていない').toBe(1_000)

    const purchaseEntries = await testPrisma.pointLedgerEntry.count({
      where: { userId, txType: PointTxType.PURCHASE },
    })
    expect(purchaseEntries).toBe(1)
  })

  it('異なる event_id でも、同じ決済へのポイント付与は 1 回だけ', async () => {
    const userId = await createUser('webhook-distinct@example.test')
    const payment = await createPayment(userId, 1_000)

    // プロバイダが別イベントとして同じ状態を 3 回通知してくる状況
    const attempts = [1, 2, 3].map((n) => {
      const { body, headers } = buildSignedWebhook(payment.providerPaymentId, `evt_${n}`)
      const verification = getPaymentProvider().verifyWebhook(body, headers)
      return handleWebhook(verification, JSON.parse(body))
    })

    await Promise.allSettled(attempts)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.paid).toBe(1_000)

    const purchaseEntries = await testPrisma.pointLedgerEntry.count({
      where: { userId, txType: PointTxType.PURCHASE },
    })
    expect(purchaseEntries, 'PURCHASE 記帳は 1 件だけ（INV-9）').toBe(1)
  })

  it('決済の状態変更を同時に行っても、成功するのは 1 件だけ', async () => {
    const userId = await createUser('payment-race@example.test')
    const payment = await createPayment(userId, 1_000)

    const attempts = Array.from({ length: 5 }, () =>
      testPrisma.$transaction((tx) =>
        applyPaymentStatus(tx, payment.id, PaymentStatus.SUCCEEDED),
      ),
    )
    const results = await Promise.allSettled(attempts)

    // すべて成功しうる（2 件目以降は「同じ状態への再適用」として何もしない）
    const granted = results.filter((r) => r.status === 'fulfilled' && r.value.granted).length
    expect(granted, '実際に付与したのは 1 件だけ').toBe(1)

    const balance = await getBalance(testPrisma, userId)
    expect(balance.paid).toBe(1_000)
  })
})
