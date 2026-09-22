'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Field } from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'
import { postJson } from '@/lib/http/client.ts'

/**
 * 公開・販売停止・再開の操作。
 *
 * 公開は不可逆（価格・口数・景品構成が凍結される）ため、確認ダイアログを挟む。
 * 停止・再開は理由の入力を必須にし、監査ログへ残す。
 */

const MIN_REASON_LENGTH = 5

export function OripaPublishControls({
  campaignId,
  status,
  publishable,
  canPublish,
  canSuspend,
}: {
  campaignId: string
  status: string
  publishable: boolean
  canPublish: boolean
  canSuspend: boolean
}) {
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, setIsPending] = useState(false)

  const isDraft = status === 'DRAFT'
  const isSuspended = status === 'SUSPENDED'
  const canBeSuspended = status === 'ACTIVE' || status === 'SCHEDULED'

  async function run(
    url: string,
    method: 'POST' | 'DELETE',
    payload: unknown,
    successMessage: string,
  ) {
    setError(undefined)
    setMessage(undefined)
    setIsPending(true)
    try {
      const result = await postJson<unknown>(url, method, payload)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setMessage(successMessage)
      setReason('')
      router.refresh()
    } finally {
      setIsPending(false)
    }
  }

  async function handlePublish() {
    const confirmed = window.confirm(
      'このオリパを公開します。\n\n' +
        '公開後は価格・総口数・景品構成・当選確率を変更できません。\n' +
        '抽選順のコミットハッシュが記録され、販売終了後に第三者が検証できるようになります。\n\n' +
        'よろしいですか？',
    )
    if (!confirmed) return
    await run(
      `/api/admin/oripas/${campaignId}/publish`,
      'POST',
      { confirm: true },
      '公開しました。',
    )
  }

  async function handleSuspend() {
    if (reason.trim().length < MIN_REASON_LENGTH) {
      setError(`理由は ${MIN_REASON_LENGTH} 文字以上で入力してください`)
      return
    }
    const confirmed = window.confirm(
      '販売を停止します。すでに確定した抽選結果には影響しません。よろしいですか？',
    )
    if (!confirmed) return
    await run(
      `/api/admin/oripas/${campaignId}/suspend`,
      'POST',
      { reason: reason.trim() },
      '販売を停止しました。',
    )
  }

  async function handleResume() {
    if (reason.trim().length < MIN_REASON_LENGTH) {
      setError(`理由は ${MIN_REASON_LENGTH} 文字以上で入力してください`)
      return
    }
    await run(
      `/api/admin/oripas/${campaignId}/suspend`,
      'DELETE',
      { reason: reason.trim() },
      '販売を再開しました。',
    )
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      {isDraft ? (
        canPublish ? (
          <div className="space-y-2">
            <Button type="button" onClick={handlePublish} disabled={isPending || !publishable}>
              {isPending ? '処理中…' : '公開する'}
            </Button>
            {!publishable ? (
              <p className="text-sm text-amber-300">
                公開条件を満たしていません。下のチェックリストを解消してください。
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-base-100 text-sm">公開する権限がありません。</p>
        )
      ) : null}

      {canSuspend && (canBeSuspended || isSuspended) ? (
        <div className="space-y-3">
          <Field id="suspend-reason" label="理由" required hint="監査ログに記録されます。">
            <Input
              id="suspend-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例: 景品の在庫状態に疑義があるため"
            />
          </Field>
          {isSuspended ? (
            <Button
              type="button"
              variant="secondary"
              onClick={handleResume}
              disabled={isPending}
            >
              販売を再開する
            </Button>
          ) : (
            <Button type="button" variant="danger" onClick={handleSuspend} disabled={isPending}>
              販売を停止する
            </Button>
          )}
        </div>
      ) : null}
    </div>
  )
}
