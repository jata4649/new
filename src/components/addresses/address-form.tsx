'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Field } from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'
import { postJson } from '@/lib/http/client.ts'
import { PREFECTURES } from '@/modules/addresses/schema.ts'

/**
 * 配送先の登録・編集フォーム。
 *
 * ■ 正規化はサーバーで行う
 *   郵便番号のハイフンや全角数字は Zod が吸収する。
 *   画面側でも整えたくなるが、二重に整形すると
 *   「どちらが正か」が曖昧になる。ここでは入力をそのまま送る。
 *
 * ■ 都道府県は選択式
 *   自由入力にすると「東京」「東京都」「とうきょう」が混ざり、
 *   後から集計も突き合わせもできなくなる。
 */

export interface AddressFormValues {
  id?: string
  recipientName: string
  postalCode: string
  prefecture: string
  city: string
  addressLine1: string
  addressLine2: string
  phoneNumber: string
  isDefault: boolean
}

const EMPTY: AddressFormValues = {
  recipientName: '',
  postalCode: '',
  prefecture: '',
  city: '',
  addressLine1: '',
  addressLine2: '',
  phoneNumber: '',
  isDefault: false,
}

export function AddressForm({
  initial,
  onDone,
}: {
  initial?: AddressFormValues
  /** 保存後に呼ばれる（呼び出し側でフォームを閉じる） */
  onDone?: () => void
}) {
  const router = useRouter()
  const [values, setValues] = useState<AddressFormValues>(initial ?? EMPTY)
  const [error, setError] = useState<string | undefined>()
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [isPending, setIsPending] = useState(false)

  const isEdit = Boolean(initial?.id)

  function set<K extends keyof AddressFormValues>(key: K, value: AddressFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (isPending) return

    setError(undefined)
    setFieldErrors({})
    setIsPending(true)

    try {
      const payload = {
        recipientName: values.recipientName,
        postalCode: values.postalCode,
        prefecture: values.prefecture,
        city: values.city,
        addressLine1: values.addressLine1,
        addressLine2: values.addressLine2 || undefined,
        phoneNumber: values.phoneNumber,
        isDefault: values.isDefault,
      }

      const result = isEdit
        ? await postJson<{ id: string }>(`/api/me/addresses/${initial?.id}`, 'PATCH', payload)
        : await postJson<{ id: string }>('/api/me/addresses', 'POST', payload)

      if (!result.ok) {
        setError(result.message)
        if (result.details) {
          const next: Record<string, string> = {}
          for (const detail of result.details) next[detail.field] = detail.message
          setFieldErrors(next)
        }
        return
      }

      if (!isEdit) setValues(EMPTY)
      router.refresh()
      onDone?.()
    } finally {
      setIsPending(false)
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Field id="recipientName" label="宛名" required error={fieldErrors.recipientName}>
        <Input
          id="recipientName"
          value={values.recipientName}
          onChange={(event) => set('recipientName', event.target.value)}
          autoComplete="name"
          required
        />
      </Field>

      <Field
        id="postalCode"
        label="郵便番号"
        required
        hint="ハイフンは有っても無くても構いません"
        error={fieldErrors.postalCode}
      >
        <Input
          id="postalCode"
          value={values.postalCode}
          onChange={(event) => set('postalCode', event.target.value)}
          autoComplete="postal-code"
          inputMode="numeric"
          placeholder="1500001"
          required
        />
      </Field>

      <Field id="prefecture" label="都道府県" required error={fieldErrors.prefecture}>
        <select
          id="prefecture"
          value={values.prefecture}
          onChange={(event) => set('prefecture', event.target.value)}
          className="border-base-700 bg-base-900 text-base-50 h-11 w-full rounded-lg border px-3 text-base"
          required
        >
          <option value="">選択してください</option>
          {PREFECTURES.map((prefecture) => (
            <option key={prefecture} value={prefecture}>
              {prefecture}
            </option>
          ))}
        </select>
      </Field>

      <Field id="city" label="市区町村" required error={fieldErrors.city}>
        <Input
          id="city"
          value={values.city}
          onChange={(event) => set('city', event.target.value)}
          autoComplete="address-level2"
          placeholder="渋谷区"
          required
        />
      </Field>

      <Field id="addressLine1" label="番地" required error={fieldErrors.addressLine1}>
        <Input
          id="addressLine1"
          value={values.addressLine1}
          onChange={(event) => set('addressLine1', event.target.value)}
          autoComplete="address-line1"
          placeholder="神南 1-2-3"
          required
        />
      </Field>

      <Field
        id="addressLine2"
        label="建物名・部屋番号"
        hint="任意です"
        error={fieldErrors.addressLine2}
      >
        <Input
          id="addressLine2"
          value={values.addressLine2}
          onChange={(event) => set('addressLine2', event.target.value)}
          autoComplete="address-line2"
        />
      </Field>

      <Field
        id="phoneNumber"
        label="電話番号"
        required
        hint="配送業者からの連絡に使います"
        error={fieldErrors.phoneNumber}
      >
        <Input
          id="phoneNumber"
          value={values.phoneNumber}
          onChange={(event) => set('phoneNumber', event.target.value)}
          autoComplete="tel"
          inputMode="tel"
          placeholder="09012345678"
          required
        />
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={values.isDefault}
          onChange={(event) => set('isDefault', event.target.checked)}
          className="size-4"
        />
        既定の配送先にする
      </label>

      <Button type="submit" disabled={isPending}>
        {isPending ? '保存中…' : isEdit ? '変更を保存' : '登録する'}
      </Button>
    </form>
  )
}
