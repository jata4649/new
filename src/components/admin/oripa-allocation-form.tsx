'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { postJson } from '@/lib/http/client.ts'

/**
 * 景品割当（スロット生成）。
 *
 * ランクごとに「使う物理在庫」を選び、足りない分は汎用景品で埋める。
 * 送信すると、そのオリパのスロットはいったん全削除されて作り直される
 * （部分更新にすると失敗時に整合性が崩れるため）。
 *
 * ■ ここで抽選順（draw_order）は表示しない
 *   管理画面に出ると内部関係者が「次に何が出るか」を知れてしまう。
 *   順序はサーバーが CSPRNG で決め、外へは一切出さない。
 */

export interface AllocatableInventory {
  id: string
  code: string
  cardName: string
  rarity: string | null
  exchangePoints: number
}

export interface TierForAllocation {
  code: string
  name: string
  slotCount: number
  /** すでに割り当て済みの物理在庫（再編集時の初期値） */
  allocatedInventoryIds: string[]
}

export interface GenericPrizeOption {
  code: string
  name: string
  exchangePoints: number
}

export function OripaAllocationForm({
  campaignId,
  tiers,
  inventories,
  genericPrizes,
}: {
  campaignId: string
  tiers: TierForAllocation[]
  inventories: AllocatableInventory[]
  genericPrizes: GenericPrizeOption[]
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(tiers.map((tier) => [tier.code, tier.allocatedInventoryIds])),
  )
  const [genericByTier, setGenericByTier] = useState<Record<string, string>>(() =>
    Object.fromEntries(tiers.map((tier) => [tier.code, genericPrizes[0]?.code ?? ''])),
  )
  const [error, setError] = useState<string | undefined>()
  const [details, setDetails] = useState<{ field: string; message: string }[]>([])
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, setIsPending] = useState(false)

  /** 他のランクで選択済みの在庫は選べないようにする */
  const takenByOtherTier = useMemo(() => {
    const map = new Map<string, string>()
    for (const [tierCode, ids] of Object.entries(selected)) {
      for (const id of ids) map.set(id, tierCode)
    }
    return map
  }, [selected])

  function toggle(tierCode: string, inventoryId: string) {
    setSelected((prev) => {
      const current = prev[tierCode] ?? []
      const next = current.includes(inventoryId)
        ? current.filter((id) => id !== inventoryId)
        : [...current, inventoryId]
      return { ...prev, [tierCode]: next }
    })
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(undefined)
    setDetails([])
    setMessage(undefined)

    const confirmed = window.confirm(
      'このオリパのスロットを作り直します。\n' +
        '既存のスロットは削除され、在庫の割当も解除されます。よろしいですか？',
    )
    if (!confirmed) return

    const payload = {
      allocations: tiers.map((tier) => ({
        tierCode: tier.code,
        inventoryIds: selected[tier.code] ?? [],
        genericPrizeCode: genericByTier[tier.code] || null,
      })),
    }

    setIsPending(true)
    try {
      const result = await postJson<{ totalSlots: number }>(
        `/api/admin/oripas/${campaignId}/slots`,
        'POST',
        payload,
      )
      if (!result.ok) {
        setError(result.message)
        setDetails(result.details)
        return
      }
      setMessage(
        `${result.data.totalSlots.toLocaleString('ja-JP')} 件のスロットを生成しました。` +
          '抽選順はサーバー側で暗号論的乱数によりシャッフルされています。',
      )
      router.refresh()
    } finally {
      setIsPending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      {error ? (
        <Alert tone="error" title={error}>
          {details.length > 0 ? (
            <ul className="mt-1 list-disc pl-5">
              {details.map((detail) => (
                <li key={`${detail.field}-${detail.message}`}>{detail.message}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      {tiers.map((tier) => {
        const chosen = selected[tier.code] ?? []
        const shortage = tier.slotCount - chosen.length

        return (
          <fieldset key={tier.code} className="border-base-800 space-y-3 rounded-lg border p-4">
            <legend className="text-base-100 px-1 text-sm font-bold">
              {tier.name}（{tier.code}）— 口数 {tier.slotCount.toLocaleString('ja-JP')}
            </legend>

            <p className="text-sm">
              選択中: <span className="font-bold tabular-nums">{chosen.length}</span> 件 / 不足:{' '}
              <span className={shortage > 0 ? 'font-bold text-amber-300' : 'font-bold'}>
                {Math.max(0, shortage).toLocaleString('ja-JP')}
              </span>{' '}
              件
              {shortage < 0 ? (
                <span className="ml-2 font-bold text-red-400">
                  口数を {Math.abs(shortage)} 件超えています
                </span>
              ) : null}
            </p>

            {shortage > 0 ? (
              <div className="space-y-1.5">
                <label
                  htmlFor={`generic-${tier.code}`}
                  className="text-base-100 block text-sm font-medium"
                >
                  不足分を埋める汎用景品
                </label>
                <select
                  id={`generic-${tier.code}`}
                  value={genericByTier[tier.code] ?? ''}
                  onChange={(event) =>
                    setGenericByTier((prev) => ({
                      ...prev,
                      [tier.code]: event.target.value,
                    }))
                  }
                  className="border-base-700 bg-base-900 text-base-50 h-11 w-full rounded-lg border px-3 text-base"
                >
                  <option value="">選択しない（在庫だけで埋める）</option>
                  {genericPrizes.map((prize) => (
                    <option key={prize.code} value={prize.code}>
                      {prize.name}（{prize.exchangePoints.toLocaleString('ja-JP')} P）
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="border-base-800 max-h-64 overflow-y-auto rounded-lg border">
              <ul className="divide-base-800/60 divide-y text-sm">
                {inventories.map((inventory) => {
                  const owner = takenByOtherTier.get(inventory.id)
                  const isMine = chosen.includes(inventory.id)
                  const disabled = owner !== undefined && owner !== tier.code

                  return (
                    <li key={inventory.id} className="px-3 py-2">
                      <label className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={isMine}
                          disabled={disabled}
                          onChange={() => toggle(tier.code, inventory.id)}
                          className="size-4"
                        />
                        <span className="flex-1">
                          <span className="font-bold">{inventory.cardName}</span>
                          <span className="text-base-100 ml-2 font-mono text-xs">
                            {inventory.code}
                          </span>
                          {inventory.rarity ? (
                            <span className="text-base-100 ml-2 text-xs">
                              {inventory.rarity}
                            </span>
                          ) : null}
                        </span>
                        <span className="tabular-nums">
                          {inventory.exchangePoints.toLocaleString('ja-JP')} P
                        </span>
                        {disabled ? (
                          <span className="text-base-100 text-xs">{owner} で選択中</span>
                        ) : null}
                      </label>
                    </li>
                  )
                })}
                {inventories.length === 0 ? (
                  <li className="text-base-100 px-3 py-4 text-center">
                    割当可能な在庫がありません。先に在庫を登録してください。
                  </li>
                ) : null}
              </ul>
            </div>
          </fieldset>
        )
      })}

      <Button type="submit" disabled={isPending}>
        {isPending ? '生成中…' : 'スロットを生成する'}
      </Button>
    </form>
  )
}
