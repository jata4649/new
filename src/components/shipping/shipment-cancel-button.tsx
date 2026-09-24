'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { postJson } from '@/lib/http/client.ts'

/**
 * 発送申請の取消し。
 *
 * 取り消せるのは発送準備に入る前だけ。
 * 判定はサーバーが行うが、押せる条件は画面でも揃えておく
 * （押してから断られるより、押せないほうが分かりやすい）。
 *
 * 理由を必須にしているのは、取消しの多い商品や状況を後から追えるようにするため。
 */

const MIN_REASON_LENGTH = 1

export function ShipmentCancelButton({ shipmentId }: { shipmentId: string }) {
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [isPending, setIsPending] = useState(false)

  async function handleCancel() {
    if (isPending || reason.trim().length < MIN_REASON_LENGTH) return

    const confirmed = window.confirm(
      'この発送申請を取り消します。\n\n' +
        '対象の商品は未選択へ戻り、改めてポイント交換または再申請を選べます。\n\n' +
        'よろしいですか？',
    )
    if (!confirmed) return

    setError(undefined)
    setIsPending(true)
    try {
      const result = await postJson<unknown>(
        `/api/shipping-requests/${shipmentId}/cancel`,
        'POST',
        { reason: reason.trim() },
      )
      if (!result.ok) {
        setError(result.message)
        // 同時に管理者が進めた可能性があるので表示を更新する
        router.refresh()
        return
      }
      setReason('')
      router.refresh()
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="space-y-2">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <label htmlFor={`cancel-reason-${shipmentId}`} className="text-base-100 block text-sm">
        取消しの理由
      </label>
      <input
        id={`cancel-reason-${shipmentId}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="例: 住所を間違えたため"
        className="border-base-700 bg-base-900 text-base-50 h-11 w-full rounded-lg border px-3 text-base"
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={isPending || reason.trim().length < MIN_REASON_LENGTH}
        onClick={() => void handleCancel()}
      >
        {isPending ? '取消し中…' : '発送申請を取り消す'}
      </Button>
    </div>
  )
}
