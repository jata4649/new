'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Field } from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'
import { postJson } from '@/lib/http/client.ts'

/**
 * オリパ（下書き）の作成フォーム。
 *
 * ランクの口数合計と総口数の一致は、この場で分かるようにしている。
 * ただし最終的な判定はサーバー（Zod の refine）が行う。
 * 画面の検証は入力補助であり、認可・整合性の根拠にはしない。
 */

const EFFECT_TIERS = [
  { value: 'JACKPOT', label: 'JACKPOT（最上位）' },
  { value: 'RAINBOW', label: 'RAINBOW' },
  { value: 'GOLD', label: 'GOLD' },
  { value: 'BLUE', label: 'BLUE' },
  { value: 'NORMAL', label: 'NORMAL（ハズレ相当）' },
] as const

interface TierRow {
  code: string
  name: string
  effectTier: string
  slotCount: string
}

const DEFAULT_TIERS: TierRow[] = [
  { code: 'S', name: 'S賞', effectTier: 'JACKPOT', slotCount: '1' },
  { code: 'A', name: 'A賞', effectTier: 'GOLD', slotCount: '9' },
  { code: 'B', name: 'B賞', effectTier: 'NORMAL', slotCount: '90' },
]

function parseCount(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}

/** datetime-local（ローカル時刻）を ISO 8601 へ */
function toIso(value: string): string | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function OripaForm() {
  const router = useRouter()
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [thumbnailKey, setThumbnailKey] = useState('')
  const [pricePoints, setPricePoints] = useState('500')
  const [totalSlots, setTotalSlots] = useState('100')
  const [perUserLimit, setPerUserLimit] = useState('')
  const [salesStartAt, setSalesStartAt] = useState('')
  const [salesEndAt, setSalesEndAt] = useState('')
  const [tiers, setTiers] = useState<TierRow[]>(DEFAULT_TIERS)
  const [error, setError] = useState<string | undefined>()
  const [details, setDetails] = useState<{ field: string; message: string }[]>([])
  const [isPending, setIsPending] = useState(false)

  const tierSum = tiers.reduce((sum, tier) => sum + parseCount(tier.slotCount), 0)
  const total = parseCount(totalSlots)
  const sumMatches = tierSum === total && total > 0

  function updateTier(index: number, patch: Partial<TierRow>) {
    setTiers((prev) => prev.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)))
  }

  function addTier() {
    setTiers((prev) => [...prev, { code: '', name: '', effectTier: 'NORMAL', slotCount: '1' }])
  }

  function removeTier(index: number) {
    setTiers((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(undefined)
    setDetails([])

    const startIso = toIso(salesStartAt)
    const endIso = toIso(salesEndAt)
    if (!startIso || !endIso) {
      setError('販売開始日時と販売終了日時を入力してください')
      return
    }
    if (!sumMatches) {
      setError(`景品ランクの口数合計（${tierSum}）が総口数（${total}）と一致していません`)
      return
    }

    const payload = {
      slug: slug.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
      thumbnailKey: thumbnailKey.trim() || undefined,
      pricePoints: parseCount(pricePoints),
      totalSlots: total,
      perUserLimit: perUserLimit.trim() ? parseCount(perUserLimit) : null,
      salesStartAt: startIso,
      salesEndAt: endIso,
      effectSetKey: 'default',
      tiers: tiers.map((tier, index) => ({
        code: tier.code.trim(),
        name: tier.name.trim(),
        effectTier: tier.effectTier,
        slotCount: parseCount(tier.slotCount),
        displayOrder: index,
      })),
    }

    setIsPending(true)
    try {
      const result = await postJson<{ id: string }>('/api/admin/oripas', 'POST', payload)
      if (!result.ok) {
        setError(result.message)
        setDetails(result.details)
        return
      }
      router.push(`/admin/oripas/${result.data.id}`)
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
                <li key={`${detail.field}-${detail.message}`}>
                  {detail.field}: {detail.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="slug" label="スラッグ（URL）" required hint="半角小文字・数字・ハイフン。">
          <Input
            id="slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="例: sample-premium-01"
          />
        </Field>
        <Field id="name" label="名称" required>
          <Input
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例: サンプルプレミアムオリパ"
          />
        </Field>
        <Field id="pricePoints" label="1 口価格（ポイント）" required>
          <Input
            id="pricePoints"
            type="number"
            inputMode="numeric"
            value={pricePoints}
            onChange={(event) => setPricePoints(event.target.value)}
          />
        </Field>
        <Field
          id="totalSlots"
          label="総口数"
          required
          hint="公開後は変更できません。ランクの口数合計と一致させてください。"
        >
          <Input
            id="totalSlots"
            type="number"
            inputMode="numeric"
            value={totalSlots}
            onChange={(event) => setTotalSlots(event.target.value)}
          />
        </Field>
        <Field id="perUserLimit" label="1 ユーザーあたりの上限口数" hint="空欄なら上限なし。">
          <Input
            id="perUserLimit"
            type="number"
            inputMode="numeric"
            value={perUserLimit}
            onChange={(event) => setPerUserLimit(event.target.value)}
          />
        </Field>
        <Field id="thumbnailKey" label="サムネイル画像キー">
          <Input
            id="thumbnailKey"
            value={thumbnailKey}
            onChange={(event) => setThumbnailKey(event.target.value)}
            placeholder="placeholder:SR:280:front"
          />
        </Field>
        <Field id="salesStartAt" label="販売開始日時" required>
          <Input
            id="salesStartAt"
            type="datetime-local"
            value={salesStartAt}
            onChange={(event) => setSalesStartAt(event.target.value)}
          />
        </Field>
        <Field id="salesEndAt" label="販売終了日時" required>
          <Input
            id="salesEndAt"
            type="datetime-local"
            value={salesEndAt}
            onChange={(event) => setSalesEndAt(event.target.value)}
          />
        </Field>
      </div>

      <Field id="description" label="説明">
        <textarea
          id="description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          className="border-base-700 bg-base-900 text-base-50 w-full rounded-lg border px-3 py-2 text-base"
        />
      </Field>

      <fieldset className="border-base-800 space-y-4 rounded-lg border p-4">
        <legend className="text-base-100 px-1 text-sm font-bold">景品ランク</legend>
        <p className="text-base-100/70 text-xs">
          当選確率は「ランクの口数 ÷ 総口数」です。確率を直接入力する項目はありません
          （確率と景品数の不一致を原理的に作らないため）。
        </p>

        <div className="space-y-3">
          {tiers.map((tier, index) => (
            <div
              key={index}
              className="border-base-800 grid items-end gap-3 rounded-lg border p-3 sm:grid-cols-5"
            >
              <Field id={`tier-code-${index}`} label="コード" required>
                <Input
                  id={`tier-code-${index}`}
                  value={tier.code}
                  onChange={(event) => updateTier(index, { code: event.target.value })}
                  placeholder="S"
                />
              </Field>
              <Field id={`tier-name-${index}`} label="ランク名" required>
                <Input
                  id={`tier-name-${index}`}
                  value={tier.name}
                  onChange={(event) => updateTier(index, { name: event.target.value })}
                  placeholder="S賞"
                />
              </Field>
              <Field id={`tier-effect-${index}`} label="演出">
                <select
                  id={`tier-effect-${index}`}
                  value={tier.effectTier}
                  onChange={(event) => updateTier(index, { effectTier: event.target.value })}
                  className="border-base-700 bg-base-900 text-base-50 h-11 w-full rounded-lg border px-3 text-base"
                >
                  {EFFECT_TIERS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={`tier-count-${index}`} label="口数" required>
                <Input
                  id={`tier-count-${index}`}
                  type="number"
                  inputMode="numeric"
                  value={tier.slotCount}
                  onChange={(event) => updateTier(index, { slotCount: event.target.value })}
                />
              </Field>
              <Button
                type="button"
                variant="outline"
                onClick={() => removeTier(index)}
                disabled={tiers.length <= 1}
              >
                削除
              </Button>
            </div>
          ))}
        </div>

        <Button type="button" variant="secondary" onClick={addTier}>
          ランクを追加
        </Button>

        <p
          className={
            sumMatches ? 'text-sm text-emerald-300' : 'text-sm font-bold text-amber-300'
          }
        >
          ランク口数の合計: {tierSum.toLocaleString('ja-JP')} / 総口数:{' '}
          {total.toLocaleString('ja-JP')}
          {sumMatches ? '（一致）' : '（一致していません）'}
        </p>
      </fieldset>

      <Button type="submit" disabled={isPending}>
        {isPending ? '作成中…' : '下書きを作成する'}
      </Button>
    </form>
  )
}
