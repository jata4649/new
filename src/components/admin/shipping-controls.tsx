'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Field } from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'
import { postJson } from '@/lib/http/client.ts'

/**
 * 発送作業の操作。
 *
 * ■ 次の 1 手だけを出す
 *   遷移はサーバー側の表で REQUESTED → CHECKING → PACKING → SHIPPED → DELIVERED に
 *   限っている。画面でも「次に進める状態」だけを出し、飛ばしも巻き戻しも押せなくする。
 *   押してから断られるより、押せないほうが作業中に迷わない。
 *
 * ■ 発送済みには追跡番号が要る
 *   「発送したが追跡できない」は利用者から見て発送していないのと同じ。
 *   入力・API・DB の CHECK すべてで必須にしている。
 *
 * ■ 取消しは理由必須
 *   検品で欠品・破損が判明することがある。監査ログへ残す。
 */

const NEXT_STATUS: Record<string, { value: string; label: string } | undefined> = {
  REQUESTED: { value: 'CHECKING', label: '検品を開始する' },
  CHECKING: { value: 'PACKING', label: '梱包を開始する' },
  PACKING: { value: 'SHIPPED', label: '発送済みにする' },
  SHIPPED: { value: 'DELIVERED', label: '配達完了にする' },
}

/** 管理者が取り消せる状態（発送前まで） */
const CANCELLABLE = new Set(['REQUESTED', 'CHECKING', 'PACKING'])

export function ShippingControls({
  shipmentId,
  status,
  carrier,
  trackingNumber,
}: {
  shipmentId: string
  status: string
  carrier: string | null
  trackingNumber: string | null
}) {
  const router = useRouter()
  const [carrierValue, setCarrierValue] = useState(carrier ?? '')
  const [trackingValue, setTrackingValue] = useState(trackingNumber ?? '')
  const [adminNote, setAdminNote] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, setIsPending] = useState(false)

  const next = NEXT_STATUS[status]
  const requiresTracking = next?.value === 'SHIPPED'
  const canAdvance =
    !!next && (!requiresTracking || (carrierValue.trim() !== '' && trackingValue.trim() !== ''))

  async function run(
    url: string,
    payload: unknown,
    method: 'POST' | 'PATCH',
    successMessage: string,
  ) {
    setError(undefined)
    setMessage(undefined)
    setIsPending(true)
    try {
      const result = await postJson<unknown>(url, method, payload)
      if (!result.ok) {
        setError(result.message)
        router.refresh()
        return
      }
      setMessage(successMessage)
      setReason('')
      router.refresh()
    } finally {
      setIsPending(false)
    }
  }

  async function handleAdvance() {
    if (!next || !canAdvance) return

    if (requiresTracking) {
      const confirmed = window.confirm(
        '発送済みにします。\n\n' +
          `配送業者: ${carrierValue}\n追跡番号: ${trackingValue}\n\n` +
          '発送済みにすると当選商品と在庫も発送済みになり、取り消せません。\n\n' +
          'よろしいですか？',
      )
      if (!confirmed) return
    }

    await run(
      `/api/admin/shipping-requests/${shipmentId}`,
      {
        status: next.value,
        ...(carrierValue.trim() ? { carrier: carrierValue.trim() } : {}),
        ...(trackingValue.trim() ? { trackingNumber: trackingValue.trim() } : {}),
        ...(adminNote.trim() ? { adminNote: adminNote.trim() } : {}),
      },
      'PATCH',
      `${next.label.replace(/する$/, 'しました')}。`,
    )
  }

  async function handleCancel() {
    if (reason.trim() === '') return

    const confirmed = window.confirm(
      'この発送申請を取り消します。\n\n' +
        '対象の商品は利用者の手元で未選択へ戻り、再申請またはポイント交換が可能になります。\n\n' +
        'よろしいですか？',
    )
    if (!confirmed) return

    await run(
      `/api/admin/shipping-requests/${shipmentId}/cancel`,
      { reason: reason.trim() },
      'POST',
      '発送申請を取り消しました。',
    )
  }

  return (
    <div className="space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      {next ? (
        <div className="space-y-3">
          {requiresTracking ? (
            <>
              <Field id="carrier" label="配送業者" required>
                <Input
                  id="carrier"
                  value={carrierValue}
                  onChange={(event) => setCarrierValue(event.target.value)}
                  placeholder="例: ヤマト運輸"
                />
              </Field>
              <Field id="trackingNumber" label="追跡番号" required>
                <Input
                  id="trackingNumber"
                  value={trackingValue}
                  onChange={(event) => setTrackingValue(event.target.value)}
                  inputMode="numeric"
                />
              </Field>
            </>
          ) : null}

          <Field id="adminNote" label="作業メモ" hint="任意。利用者には表示しません。">
            <Input
              id="adminNote"
              value={adminNote}
              onChange={(event) => setAdminNote(event.target.value)}
            />
          </Field>

          <Button
            type="button"
            disabled={isPending || !canAdvance}
            onClick={() => void handleAdvance()}
          >
            {isPending ? '処理中…' : next.label}
          </Button>
          {requiresTracking && !canAdvance ? (
            <p className="text-xs text-amber-300">
              発送済みにするには配送業者と追跡番号の入力が必要です。
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-base-100 text-sm">この申請に対して進められる作業はありません。</p>
      )}

      {CANCELLABLE.has(status) ? (
        <div className="border-base-800 space-y-2 border-t pt-4">
          <Field
            id="cancelReason"
            label="取消しの理由"
            required
            hint="監査ログに記録されます。"
          >
            <Input
              id="cancelReason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例: 検品で破損を確認したため"
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            disabled={isPending || reason.trim() === ''}
            onClick={() => void handleCancel()}
          >
            発送申請を取り消す
          </Button>
        </div>
      ) : null}
    </div>
  )
}
