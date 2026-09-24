'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Card, CardTitle } from '@/components/ui/card.tsx'
import { postJson } from '@/lib/http/client.ts'
import type { AddressItem } from '@/modules/addresses/queries.ts'

/**
 * 発送申請パネル。
 *
 * ■ まとめて申請する
 *   1 商品 1 発送にすると送料も梱包も利用者の手間も増える。
 *   発送できる当選商品を選んで、1 件の申請にまとめる。
 *
 * ■ 申請するとポイント交換はできなくなる
 *   取消しは発送準備に入る前なら可能だが、
 *   「交換のつもりが発送になっていた」を避けるため確認ダイアログで明示する。
 *
 * ■ 二重申請の防止
 *   送信中はボタンを無効化するが、保証は冪等性キー（postJson が毎回付ける）と
 *   サーバー側の行ロック・条件付き UPDATE・部分 UNIQUE が行う。
 */

export interface ShippablePrize {
  id: string
  name: string
  exchangePoints: number
}

interface RequestSuccess {
  shippingRequestId: string
  itemCount: number
  recipientName: string
}

export function ShippingRequestPanel({
  prizes,
  addresses,
}: {
  prizes: ShippablePrize[]
  addresses: AddressItem[]
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [addressId, setAddressId] = useState<string>(
    addresses.find((address) => address.isDefault)?.id ?? addresses[0]?.id ?? '',
  )
  const [error, setError] = useState<string | undefined>()
  const [isPending, setIsPending] = useState(false)

  function toggle(prizeId: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(prizeId)) next.delete(prizeId)
      else next.add(prizeId)
      return next
    })
  }

  function selectAll() {
    setSelected(new Set(prizes.map((prize) => prize.id)))
  }

  async function handleSubmit() {
    if (isPending || selected.size === 0 || !addressId) return

    const address = addresses.find((item) => item.id === addressId)
    const confirmed = window.confirm(
      `${selected.size} 点の発送を申請します。\n\n` +
        `お届け先: ${address?.recipientName ?? ''}（〒${address?.postalCode ?? ''}）\n\n` +
        '申請するとこれらの商品はポイント交換できなくなります。\n' +
        '発送準備に入る前であれば取り消せます。\n\n' +
        'よろしいですか？',
    )
    if (!confirmed) return

    setError(undefined)
    setIsPending(true)

    try {
      const result = await postJson<RequestSuccess>('/api/shipping-requests', 'POST', {
        prizeIds: [...selected],
        addressId,
        confirm: true,
      })

      if (!result.ok) {
        setError(result.message)
        // 他のタブで交換された可能性があるので表示を更新する
        router.refresh()
        return
      }

      setSelected(new Set())
      router.push('/mypage/shipments')
      router.refresh()
    } finally {
      setIsPending(false)
    }
  }

  if (prizes.length === 0) return null

  if (addresses.length === 0) {
    return (
      <Card>
        <CardTitle>発送申請</CardTitle>
        <Alert tone="info" className="mt-3">
          発送申請には配送先の登録が必要です。{' '}
          <a href="/mypage/addresses" className="text-accent-400 underline">
            配送先を登録する
          </a>
        </Alert>
      </Card>
    )
  }

  return (
    <Card>
      <CardTitle>発送申請</CardTitle>
      <p className="text-base-100/70 mt-1 text-xs">
        発送できる商品をまとめて申請できます。申請後はポイント交換できなくなります。
      </p>

      {error ? (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      ) : null}

      <fieldset className="mt-4">
        <legend className="text-base-100 text-sm font-medium">発送する商品</legend>
        <ul className="mt-2 space-y-2">
          {prizes.map((prize) => (
            <li key={prize.id}>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(prize.id)}
                  onChange={() => toggle(prize.id)}
                  className="mt-1 size-4 shrink-0"
                />
                <span>{prize.name}</span>
              </label>
            </li>
          ))}
        </ul>
        {prizes.length > 1 ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={selectAll}
          >
            すべて選ぶ
          </Button>
        ) : null}
      </fieldset>

      <div className="mt-4 space-y-1.5">
        <label htmlFor="shipping-address" className="text-base-100 block text-sm font-medium">
          お届け先
        </label>
        <select
          id="shipping-address"
          value={addressId}
          onChange={(event) => setAddressId(event.target.value)}
          className="border-base-700 bg-base-900 text-base-50 h-11 w-full rounded-lg border px-3 text-base"
        >
          {addresses.map((address) => (
            <option key={address.id} value={address.id}>
              {address.recipientName}（〒{address.postalCode} {address.prefecture}
              {address.city}）
            </option>
          ))}
        </select>
        <p className="text-base-100/70 text-xs">
          <a href="/mypage/addresses" className="text-accent-400 underline">
            配送先を追加・編集する
          </a>
        </p>
      </div>

      <Button
        type="button"
        className="mt-4 w-full"
        disabled={isPending || selected.size === 0}
        onClick={() => void handleSubmit()}
      >
        {isPending ? '申請中…' : `${selected.size} 点の発送を申請する`}
      </Button>
    </Card>
  )
}
