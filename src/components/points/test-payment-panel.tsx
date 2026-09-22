'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Card, CardTitle } from '@/components/ui/card.tsx'
import { TEST_PAYMENT_AMOUNTS } from '@/modules/payments/schema.ts'

/**
 * テスト決済パネル（開発用）。
 *
 * 【重要】現金は一切扱わない。カード情報の入力欄も作らない。
 *
 * ここから再現できること:
 *   決済成功 / 決済失敗 / 取消し / 返金
 * Webhook の重複・遅延・順序逆転は、管理画面（Phase 3 の /admin/test-payments）
 * から確認できる。
 */

interface CreatedPayment {
  id: string
  providerPaymentId: string
  amountYen: number
  grantPoints: number
  status: string
}

const STATUS_ACTIONS = [
  { status: 'SUCCEEDED', label: '決済成功にする', variant: 'primary' as const },
  { status: 'FAILED', label: '決済失敗にする', variant: 'secondary' as const },
  { status: 'CANCELLED', label: '取消しにする', variant: 'secondary' as const },
]

/** 冪等性キー。再送しても二重実行されないことを確認するために使う。 */
function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

export function TestPaymentPanel() {
  const router = useRouter()
  const [amount, setAmount] = useState<number>(TEST_PAYMENT_AMOUNTS[1])
  const [payment, setPayment] = useState<CreatedPayment | null>(null)
  const [message, setMessage] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [isPending, setIsPending] = useState(false)

  async function callApi(
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ ok: boolean; data?: unknown; message?: string }> {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    })

    const json: unknown = await response.json()

    if (!response.ok) {
      const detail =
        typeof json === 'object' &&
        json !== null &&
        'error' in json &&
        typeof (json as { error: { message?: unknown } }).error?.message === 'string'
          ? (json as { error: { message: string } }).error.message
          : '処理に失敗しました'
      return { ok: false, message: detail }
    }

    return {
      ok: true,
      data: (json as { data: unknown }).data,
    }
  }

  async function handleCreate() {
    setIsPending(true)
    setError(undefined)
    setMessage(undefined)

    try {
      const result = await callApi(
        '/api/test-payments',
        { amountYen: amount },
        newIdempotencyKey(),
      )

      if (!result.ok) {
        setError(result.message)
        return
      }

      setPayment(result.data as CreatedPayment)
      setMessage('テスト決済を作成しました。この時点ではポイントは付与されません。')
    } finally {
      setIsPending(false)
    }
  }

  async function handleStatus(status: string) {
    if (!payment) return

    setIsPending(true)
    setError(undefined)
    setMessage(undefined)

    try {
      const result = await callApi(
        `/api/test-payments/${payment.id}/status`,
        { status },
        newIdempotencyKey(),
      )

      if (!result.ok) {
        setError(result.message)
        return
      }

      const data = result.data as { status: string; granted: boolean; grantedPoints: number }
      setPayment({ ...payment, status: data.status })
      setMessage(
        data.granted
          ? `決済が成功し、${data.grantedPoints.toLocaleString('ja-JP')} ポイントを付与しました。`
          : `状態を ${data.status} に変更しました。ポイントは付与されていません。`,
      )
      router.refresh()
    } finally {
      setIsPending(false)
    }
  }

  /** 同じ冪等性キーで 2 回送り、二重付与されないことを確認する */
  async function handleDuplicateTest() {
    if (!payment) return

    setIsPending(true)
    setError(undefined)
    setMessage(undefined)

    try {
      const key = newIdempotencyKey()
      const body = { status: 'SUCCEEDED' }

      await callApi(`/api/test-payments/${payment.id}/status`, body, key)
      const second = await callApi(`/api/test-payments/${payment.id}/status`, body, key)

      setMessage(
        second.ok
          ? '同じ冪等性キーで 2 回送信しました。ポイント履歴を確認すると、付与は 1 回だけです。'
          : `2 回目は拒否されました: ${second.message}`,
      )
      setPayment({ ...payment, status: 'SUCCEEDED' })
      router.refresh()
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="space-y-4">
      <Alert tone="warning" title="テスト環境です">
        現金決済は行われません。カード情報の入力も不要です。
        ここで発行されるポイントはすべてテスト用です。
      </Alert>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      <Card>
        <CardTitle>1. テスト決済を作成する</CardTitle>
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor="amount" className="text-base-100 block text-sm font-medium">
              金額
            </label>
            <select
              id="amount"
              value={amount}
              onChange={(event) => setAmount(Number(event.target.value))}
              disabled={isPending}
              className="border-base-700 bg-base-900 mt-1 h-11 w-full rounded-lg border px-3 text-base"
            >
              {TEST_PAYMENT_AMOUNTS.map((value) => (
                <option key={value} value={value}>
                  {value.toLocaleString('ja-JP')} 円 → {value.toLocaleString('ja-JP')} ポイント
                </option>
              ))}
            </select>
          </div>

          <Button onClick={handleCreate} disabled={isPending}>
            {isPending ? '処理中…' : 'テスト決済を作成'}
          </Button>
        </div>
      </Card>

      {payment ? (
        <Card>
          <CardTitle>2. 決済の結果を選ぶ</CardTitle>
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-base-100">決済 ID</dt>
              <dd className="font-mono text-xs break-all">{payment.providerPaymentId}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-base-100">現在の状態</dt>
              <dd className="font-bold">{payment.status}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-base-100">付与予定</dt>
              <dd className="tabular-nums">{payment.grantPoints.toLocaleString('ja-JP')} P</dd>
            </div>
          </dl>

          <div className="mt-4 flex flex-wrap gap-2">
            {STATUS_ACTIONS.map((action) => (
              <Button
                key={action.status}
                variant={action.variant}
                size="sm"
                onClick={() => handleStatus(action.status)}
                disabled={isPending}
              >
                {action.label}
              </Button>
            ))}
            {payment.status === 'SUCCEEDED' ? (
              <Button
                variant="danger"
                size="sm"
                onClick={() => handleStatus('REFUNDED')}
                disabled={isPending}
              >
                返金する
              </Button>
            ) : null}
          </div>

          <div className="border-base-800 mt-4 border-t pt-4">
            <p className="text-sm font-bold">冪等性の確認</p>
            <p className="text-base-100 mt-1 text-xs">
              同じ冪等性キーで 2 回送信し、ポイントが二重付与されないことを確認します。
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={handleDuplicateTest}
              disabled={isPending}
            >
              同じキーで 2 回送信する
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  )
}
