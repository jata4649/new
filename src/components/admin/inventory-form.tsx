'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { ImageKeyField } from '@/components/admin/image-key-field.tsx'
import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Field } from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'
import { postJson } from '@/lib/http/client.ts'

/**
 * カード在庫の登録・編集フォーム。
 *
 * 検証はサーバー側（Zod）が正。ここでの検証は入力補助にすぎない。
 *
 * 画像は「画像キー」で持つ。入れ方は 2 つ。
 *   - `placeholder:<レアリティ>:<色相>:<front|back>` を手で入れる
 *     （/api/placeholder が架空カードの SVG を生成して返す）
 *   - 実ファイルをアップロードして `upload:<保存名>` を受け取る
 * どちらも保存するのは 1 つの文字列なので、項目を分けていない。
 *
 * 実在カードの画像や公式ロゴは登録しないこと。
 */

const CONDITIONS = [
  { value: 'MINT', label: 'MINT（未使用同等）' },
  { value: 'NEAR_MINT', label: 'NEAR MINT（ほぼ新品）' },
  { value: 'EXCELLENT', label: 'EXCELLENT（美品）' },
  { value: 'GOOD', label: 'GOOD（並）' },
  { value: 'PLAYED', label: 'PLAYED（使用感あり）' },
  { value: 'DAMAGED', label: 'DAMAGED（傷あり）' },
  { value: 'GRADED', label: 'GRADED（鑑定済み）' },
] as const

const MANUAL_STATUSES = [
  { value: 'AVAILABLE', label: '在庫あり' },
  { value: 'DAMAGED', label: '破損' },
  { value: 'LOST', label: '紛失' },
] as const

export interface InventoryFormValues {
  code: string
  cardTitle: string
  cardName: string
  cardNumber: string
  rarity: string
  condition: string
  exchangePoints: string
  referencePriceYen: string
  costPriceYen: string
  storageLocation: string
  frontImageKey: string
  backImageKey: string
  acquisitionSource: string
  acquiredFrom: string
  acquiredAt: string
  note: string
}

export const EMPTY_INVENTORY_FORM: InventoryFormValues = {
  code: '',
  cardTitle: '',
  cardName: '',
  cardNumber: '',
  rarity: '',
  condition: 'NEAR_MINT',
  exchangePoints: '',
  referencePriceYen: '',
  costPriceYen: '',
  storageLocation: '',
  frontImageKey: '',
  backImageKey: '',
  acquisitionSource: '',
  acquiredFrom: '',
  acquiredAt: '',
  note: '',
}

/** 空文字は「未入力」として送らない（Zod の optional と合わせる） */
function optionalText(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function optionalInt(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isInteger(parsed) ? parsed : undefined
}

/** datetime-local の値（ローカル時刻）を ISO 8601 へ変換する */
function toIsoOrUndefined(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const date = new Date(trimmed)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function InventoryForm({
  mode,
  inventoryId,
  initialValues,
  initialStatus,
  locked,
}: {
  mode: 'create' | 'edit'
  inventoryId?: string
  initialValues: InventoryFormValues
  initialStatus?: string
  /** 公開済みオリパへ割当済みなど、編集を制限する理由。null なら編集可。 */
  locked?: string | null
}) {
  const router = useRouter()
  const [values, setValues] = useState(initialValues)
  const [status, setStatus] = useState(initialStatus ?? 'AVAILABLE')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, setIsPending] = useState(false)

  const statusChanged = mode === 'edit' && status !== initialStatus
  const reasonRequired = statusChanged && (status === 'DAMAGED' || status === 'LOST')

  function set<K extends keyof InventoryFormValues>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(undefined)
    setMessage(undefined)

    if (reasonRequired && reason.trim().length < 5) {
      setError('破損・紛失へ変更する場合は理由を 5 文字以上で入力してください')
      return
    }

    const payload: Record<string, unknown> = {
      cardTitle: values.cardTitle.trim(),
      cardName: values.cardName.trim(),
      cardNumber: optionalText(values.cardNumber),
      rarity: optionalText(values.rarity),
      condition: values.condition,
      exchangePoints: optionalInt(values.exchangePoints) ?? 0,
      referencePriceYen: optionalInt(values.referencePriceYen),
      costPriceYen: optionalInt(values.costPriceYen),
      storageLocation: optionalText(values.storageLocation),
      frontImageKey: optionalText(values.frontImageKey),
      backImageKey: optionalText(values.backImageKey),
      acquisitionSource: optionalText(values.acquisitionSource),
      acquiredFrom: optionalText(values.acquiredFrom),
      acquiredAt: toIsoOrUndefined(values.acquiredAt),
      note: optionalText(values.note),
    }

    if (mode === 'create') {
      payload.code = values.code.trim()
    } else {
      // 公開済みオリパへ割当済みの在庫は交換ポイントを変更できない（サーバーが拒否する）。
      // 変更していない場合は送らず、無用な 409 を避ける。
      if (payload.exchangePoints === initialValuesExchange(initialValues)) {
        delete payload.exchangePoints
      }
      if (statusChanged) payload.status = status
      if (reason.trim().length > 0) payload.reason = reason.trim()
    }

    setIsPending(true)
    try {
      const result = await postJson<{ id: string; code?: string }>(
        mode === 'create' ? '/api/admin/inventories' : `/api/admin/inventories/${inventoryId}`,
        mode === 'create' ? 'POST' : 'PATCH',
        payload,
      )

      if (!result.ok) {
        setError(result.message)
        return
      }

      if (mode === 'create') {
        router.push(`/admin/inventories/${result.data.id}`)
        router.refresh()
        return
      }

      setMessage('保存しました。')
      setReason('')
      router.refresh()
    } finally {
      setIsPending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}
      {locked ? <Alert tone="warning">{locked}</Alert> : null}

      <Alert tone="info" title="開発環境の注意">
        実在カードの画像・公式ロゴは登録しないでください。画像キーには
        <code className="mx-1">placeholder:SR:210:front</code>
        のような形式を指定すると、架空カードのプレースホルダー画像が生成されます。
      </Alert>

      {mode === 'create' ? (
        <Field
          id="code"
          label="在庫コード"
          required
          hint="物理個体ごとに一意。同じカードが 3 枚あれば 3 件登録します。"
        >
          <Input
            id="code"
            value={values.code}
            onChange={(event) => set('code', event.target.value)}
            placeholder="例: INV-0001"
          />
        </Field>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="cardTitle" label="タイトル（架空名）" required>
          <Input
            id="cardTitle"
            value={values.cardTitle}
            onChange={(event) => set('cardTitle', event.target.value)}
            placeholder="例: サンプルカードゲーム"
          />
        </Field>
        <Field id="cardName" label="カード名（架空名）" required>
          <Input
            id="cardName"
            value={values.cardName}
            onChange={(event) => set('cardName', event.target.value)}
            placeholder="例: 蒼翼のドラゴン"
          />
        </Field>
        <Field id="cardNumber" label="型番">
          <Input
            id="cardNumber"
            value={values.cardNumber}
            onChange={(event) => set('cardNumber', event.target.value)}
          />
        </Field>
        <Field id="rarity" label="レアリティ">
          <Input
            id="rarity"
            value={values.rarity}
            onChange={(event) => set('rarity', event.target.value)}
            placeholder="例: SR"
          />
        </Field>
        <Field id="condition" label="状態">
          <select
            id="condition"
            value={values.condition}
            onChange={(event) => set('condition', event.target.value)}
            className="border-base-700 bg-base-900 text-base-50 h-11 w-full rounded-lg border px-3 text-base"
          >
            {CONDITIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="exchangePoints"
          label="交換ポイント"
          required
          hint="当選者がポイント交換を選んだ場合の付与額。抽選時にスロットへ複写されます。"
        >
          <Input
            id="exchangePoints"
            type="number"
            inputMode="numeric"
            value={values.exchangePoints}
            onChange={(event) => set('exchangePoints', event.target.value)}
          />
        </Field>
        <Field id="referencePriceYen" label="参考価格（円）">
          <Input
            id="referencePriceYen"
            type="number"
            inputMode="numeric"
            value={values.referencePriceYen}
            onChange={(event) => set('referencePriceYen', event.target.value)}
          />
        </Field>
        <Field id="costPriceYen" label="仕入価格（円）">
          <Input
            id="costPriceYen"
            type="number"
            inputMode="numeric"
            value={values.costPriceYen}
            onChange={(event) => set('costPriceYen', event.target.value)}
          />
        </Field>
        <ImageKeyField
          id="frontImageKey"
          label="表面画像キー"
          value={values.frontImageKey}
          onChange={(next) => set('frontImageKey', next)}
          placeholder="placeholder:SR:210:front"
        />
        <ImageKeyField
          id="backImageKey"
          label="裏面画像キー"
          value={values.backImageKey}
          onChange={(next) => set('backImageKey', next)}
          placeholder="placeholder:SR:210:back"
        />
        <Field id="storageLocation" label="保管場所">
          <Input
            id="storageLocation"
            value={values.storageLocation}
            onChange={(event) => set('storageLocation', event.target.value)}
          />
        </Field>
      </div>

      <fieldset className="border-base-800 space-y-4 rounded-lg border p-4">
        <legend className="text-base-100 px-1 text-sm font-bold">仕入情報（古物台帳）</legend>
        <p className="text-base-100/70 text-xs">
          古物営業法の帳簿要件を満たすため、仕入時点で記録します。後から遡って作れません。
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="acquisitionSource" label="仕入経路">
            <Input
              id="acquisitionSource"
              value={values.acquisitionSource}
              onChange={(event) => set('acquisitionSource', event.target.value)}
              placeholder="例: 卸業者"
            />
          </Field>
          <Field id="acquiredFrom" label="仕入先">
            <Input
              id="acquiredFrom"
              value={values.acquiredFrom}
              onChange={(event) => set('acquiredFrom', event.target.value)}
            />
          </Field>
          <Field id="acquiredAt" label="仕入日時">
            <Input
              id="acquiredAt"
              type="datetime-local"
              value={values.acquiredAt}
              onChange={(event) => set('acquiredAt', event.target.value)}
            />
          </Field>
        </div>
      </fieldset>

      {mode === 'edit' ? (
        <fieldset className="border-base-800 space-y-4 rounded-lg border p-4">
          <legend className="text-base-100 px-1 text-sm font-bold">状態の手動変更</legend>
          <p className="text-base-100/70 text-xs">
            当選済み・発送済みなどの状態は抽選・発送処理が設定するため、ここでは変更できません。
          </p>
          <Field id="status" label="在庫状態">
            <select
              id="status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="border-base-700 bg-base-900 text-base-50 h-11 w-full rounded-lg border px-3 text-base"
            >
              {MANUAL_STATUSES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
              {initialStatus && !MANUAL_STATUSES.some((s) => s.value === initialStatus) ? (
                <option value={initialStatus}>{initialStatus}（変更不可）</option>
              ) : null}
            </select>
          </Field>
          <Field
            id="reason"
            label="理由"
            required={reasonRequired}
            hint="監査ログに記録されます。"
          >
            <Input
              id="reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例: 検品で角に折れを確認したため"
            />
          </Field>
        </fieldset>
      ) : null}

      <Button type="submit" disabled={isPending}>
        {isPending ? '送信中…' : mode === 'create' ? '登録する' : '保存する'}
      </Button>
    </form>
  )
}

function initialValuesExchange(initial: InventoryFormValues): number | undefined {
  return optionalInt(initial.exchangePoints)
}
