'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Field } from '@/components/ui/field.tsx'
import type { UserStatus } from '@/generated/prisma/enums.ts'

/**
 * ユーザーのステータス変更。
 *
 * 要件:
 *  - 管理画面の操作に確認ダイアログを設ける
 *  - 危険な操作には理由入力を要求する
 *
 * 理由はクライアント・サーバー（Zod）・監査ログの 3 か所で担保する。
 * ここでの検証は利便性のためであり、本体はサーバー側。
 */

const STATUS_OPTIONS: { value: UserStatus; label: string; description: string }[] = [
  { value: 'ACTIVE', label: '利用中に戻す', description: 'すべての機能を再び利用できます' },
  {
    value: 'SUSPENDED',
    label: '停止する',
    description:
      '抽選・ポイント交換・発送申請ができなくなり、ログイン中の端末も即座に締め出されます',
  },
  {
    value: 'WITHDRAWN',
    label: '退会処理をする',
    description: '退会扱いにします。台帳・抽選履歴は保持されます',
  },
]

const MIN_REASON_LENGTH = 5

export function UserStatusForm({
  userId,
  currentStatus,
}: {
  userId: string
  currentStatus: UserStatus
}) {
  const router = useRouter()
  const [status, setStatus] = useState<UserStatus | ''>('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [isPending, setIsPending] = useState(false)

  const selected = STATUS_OPTIONS.find((option) => option.value === status)
  const availableOptions = STATUS_OPTIONS.filter((option) => option.value !== currentStatus)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(undefined)

    if (!status) {
      setError('変更後のステータスを選択してください')
      return
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      setError(`理由は ${MIN_REASON_LENGTH} 文字以上で入力してください`)
      return
    }

    // 確認ダイアログ。取り返しがつきにくい操作なので必ず挟む。
    const confirmed = window.confirm(
      `このユーザーを「${selected?.label}」します。\n\n理由: ${reason.trim()}\n\nよろしいですか？`,
    )
    if (!confirmed) return

    setIsPending(true)
    try {
      const response = await fetch(`/api/admin/users/${userId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reason: reason.trim() }),
      })

      const body: unknown = await response.json()

      if (!response.ok) {
        const message =
          typeof body === 'object' &&
          body !== null &&
          'error' in body &&
          typeof (body as { error: { message?: unknown } }).error?.message === 'string'
            ? (body as { error: { message: string } }).error.message
            : '変更に失敗しました'
        setError(message)
        return
      }

      setStatus('')
      setReason('')
      router.refresh()
    } finally {
      setIsPending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Field id="status" label="変更後のステータス" required>
        <select
          id="status"
          value={status}
          onChange={(event) => setStatus(event.target.value as UserStatus | '')}
          className="border-base-700 bg-base-900 h-11 w-full rounded-lg border px-3 text-base"
        >
          <option value="">選択してください</option>
          {availableOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      {selected ? <Alert tone="warning">{selected.description}</Alert> : null}

      <Field
        id="reason"
        label="理由"
        required
        hint="監査ログに記録されます。後から経緯を追えるよう具体的に記入してください。"
      >
        <textarea
          id="reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={500}
          className="border-base-700 bg-base-900 w-full rounded-lg border px-3 py-2 text-base"
        />
      </Field>

      <Button type="submit" variant="danger" disabled={isPending || !status}>
        {isPending ? '変更中…' : 'ステータスを変更する'}
      </Button>
    </form>
  )
}
