'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { AddressForm, type AddressFormValues } from '@/components/addresses/address-form.tsx'
import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Card } from '@/components/ui/card.tsx'
import { postJson } from '@/lib/http/client.ts'
import type { AddressItem } from '@/modules/addresses/queries.ts'

/**
 * 配送先の一覧・編集・削除。
 *
 * ■ 削除しても過去の発送申請は変わらない
 *   申請は宛先をスナップショットで持っているため。
 *   利用者が不安にならないよう、その旨を画面にも書く。
 *
 * ■ 既定は必ず 1 件
 *   既定を削除したらサーバー側が次の 1 件を繰り上げる。
 *   「既定が無い」状態を作らないことで、発送申請の初期選択が常に決まる。
 */

function toFormValues(address: AddressItem): AddressFormValues {
  return {
    id: address.id,
    recipientName: address.recipientName,
    postalCode: address.postalCode,
    prefecture: address.prefecture,
    city: address.city,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2 ?? '',
    phoneNumber: address.phoneNumber,
    isDefault: address.isDefault,
  }
}

export function AddressList({ addresses }: { addresses: AddressItem[] }) {
  const router = useRouter()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [pendingId, setPendingId] = useState<string | null>(null)

  async function run(
    url: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    payload: unknown,
    id: string,
    successMessage: string,
  ) {
    setError(undefined)
    setMessage(undefined)
    setPendingId(id)
    try {
      const result = await postJson<unknown>(url, method, payload)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setMessage(successMessage)
      router.refresh()
    } finally {
      setPendingId(null)
    }
  }

  async function handleDelete(address: AddressItem) {
    const confirmed = window.confirm(
      `「${address.recipientName}」宛の配送先を削除します。\n\n` +
        'すでに申請済みの発送には影響しません（申請時の宛先が記録されています）。\n\n' +
        'よろしいですか？',
    )
    if (!confirmed) return
    await run(
      `/api/me/addresses/${address.id}`,
      'DELETE',
      {},
      address.id,
      '配送先を削除しました。',
    )
  }

  async function handleSetDefault(address: AddressItem) {
    await run(
      `/api/me/addresses/${address.id}`,
      'PATCH',
      { isDefault: true },
      address.id,
      '既定の配送先を変更しました。',
    )
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      {addresses.length === 0 ? (
        <Card>
          <p className="text-base-100 text-sm">
            配送先がまだありません。発送申請の前に登録してください。
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {addresses.map((address) => (
            <li key={address.id}>
              <Card className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-bold">{address.recipientName}</p>
                  {address.isDefault ? (
                    <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-bold text-emerald-300">
                      既定
                    </span>
                  ) : null}
                </div>
                <p className="text-base-100 text-sm">
                  〒{address.postalCode} {address.prefecture}
                  {address.city}
                  {address.addressLine1}
                  {address.addressLine2 ? ` ${address.addressLine2}` : ''}
                </p>
                <p className="text-base-100 text-sm tabular-nums">{address.phoneNumber}</p>

                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditingId(editingId === address.id ? null : address.id)}
                  >
                    {editingId === address.id ? '編集をやめる' : '編集'}
                  </Button>
                  {!address.isDefault ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={pendingId === address.id}
                      onClick={() => void handleSetDefault(address)}
                    >
                      既定にする
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={pendingId === address.id}
                    onClick={() => void handleDelete(address)}
                  >
                    削除
                  </Button>
                </div>

                {editingId === address.id ? (
                  <div className="border-base-800 mt-3 border-t pt-3">
                    <AddressForm
                      initial={toFormValues(address)}
                      onDone={() => setEditingId(null)}
                    />
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
