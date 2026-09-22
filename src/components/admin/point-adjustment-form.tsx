'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Field } from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'

/**
 * 管理者によるポイント調整。
 *
 * 要件:
 *  - 理由入力を必須にする
 *  - 直接残高を書き換えない（台帳へ ADJUSTMENT として記帳される）
 *  - 確認ダイアログを設ける
 *
 * 調整後の残高をプレビューしてから確認させる。
 */

const MIN_REASON_LENGTH = 5

export function PointAdjustmentForm({
  userId,
  currentBalance,
}: {
  userId: string
  currentBalance: number
}) {
  const router = useRouter()
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, setIsPending] = useState(false)

  const parsedAmount = Number.parseInt(amount, 10)
  const isValidAmount = Number.isInteger(parsedAmount) && parsedAmount !== 0
  const previewBalance = isValidAmount ? currentBalance + parsedAmount : currentBalance

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(undefined)
    setMessage(undefined)

    if (!isValidAmount) {
      setError('増減するポイント数を入力してください（0 は指定できません）')
      return
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      setError(`理由は ${MIN_REASON_LENGTH} 文字以上で入力してください`)
      return
    }
    if (previewBalance < 0) {
      setError('調整後の残高がマイナスになります')
      return
    }

    const confirmed = window.confirm(
      `ポイントを ${parsedAmount > 0 ? '+' : ''}${parsedAmount.toLocaleString('ja-JP')} 調整します。\n\n` +
        `調整後の残高: ${previewBalance.toLocaleString('ja-JP')} P\n` +
        `理由: ${reason.trim()}\n\n` +
        'この操作は台帳と監査ログに記録されます。よろしいですか？',
    )
    if (!confirmed) return

    setIsPending(true)
    try {
      const response = await fetch(`/api/admin/users/${userId}/point-adjustments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 二重送信でポイントが二重に動かないようにする
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ amount: parsedAmount, reason: reason.trim() }),
      })

      const body: unknown = await response.json()

      if (!response.ok) {
        const detail =
          typeof body === 'object' &&
          body !== null &&
          'error' in body &&
          typeof (body as { error: { message?: unknown } }).error?.message === 'string'
            ? (body as { error: { message: string } }).error.message
            : '調整に失敗しました'
        setError(detail)
        return
      }

      const data = (body as { data: { balanceAfter: number } }).data
      setMessage(`調整しました。調整後の残高: ${data.balanceAfter.toLocaleString('ja-JP')} P`)
      setAmount('')
      setReason('')
      router.refresh()
    } finally {
      setIsPending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      <Field
        id="amount"
        label="増減するポイント数"
        required
        hint="正の値で付与、負の値で減算します。付与は無償ポイントとして発行されます。"
      >
        <Input
          id="amount"
          type="number"
          inputMode="numeric"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="例: 500 / -200"
        />
      </Field>

      {isValidAmount ? (
        <p className="text-base-100 text-sm">
          調整後の残高:{' '}
          <span
            className={previewBalance < 0 ? 'font-bold text-red-400' : 'text-base-50 font-bold'}
          >
            {previewBalance.toLocaleString('ja-JP')} P
          </span>
        </p>
      ) : null}

      <Field
        id="adjust-reason"
        label="理由"
        required
        hint="台帳と監査ログに記録されます。問い合わせ番号など、後から追える情報を含めてください。"
      >
        <textarea
          id="adjust-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={500}
          className="border-base-700 bg-base-900 w-full rounded-lg border px-3 py-2 text-base"
        />
      </Field>

      <Button type="submit" disabled={isPending || !isValidAmount}>
        {isPending ? '調整中…' : 'ポイントを調整する'}
      </Button>
    </form>
  )
}
