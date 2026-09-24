'use client'

import { useRef, useState } from 'react'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Field } from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'
import { imageSrc } from '@/lib/uploads/image-key.ts'
import { ALLOWED_IMAGE_TYPES, maxImageMegabytes } from '@/lib/uploads/limits.ts'

/**
 * 画像キーの入力欄。
 *
 * ■ 2 つの入れ方を 1 つの欄にまとめる
 *   - `placeholder:<レアリティ>:<色相>:<front|back>` を手で入れる（架空の見本）
 *   - 実ファイルをアップロードして `upload:<保存名>` を受け取る
 *   どちらも結果は同じ「画像キー」なので、保存する値は 1 つで済む。
 *
 * ■ 検証はサーバーが正
 *   `accept` 属性で拡張子を絞るのは入力補助にすぎない。
 *   種類は先頭バイトで、容量は実バイト数でサーバーが判定する。
 *   ここで弾けるのは「明らかに違うものを選んだ」場合だけ。
 *
 * ■ その場で見えるようにする
 *   画像キーは目で見て正しさが分からない文字列なので、
 *   入っていれば必ずプレビューを出す。
 *   「キーは入っているが画像が出ない」を登録前に気付ける。
 */

interface UploadSuccess {
  imageKey: string
  contentType: string
  bytes: number
}

interface ErrorBody {
  error?: {
    message?: string
    details?: { field?: string; message?: string }[]
  }
}

/**
 * 失敗の理由を取り出す。
 *
 * 検証エラーの `message` は「入力内容に誤りがあります」という総称なので、
 * それだけを出すと何を直せばよいか分からない。
 * 具体的な理由は `details` に入っているので、あればそちらを優先する。
 */
function readErrorMessage(body: unknown): string {
  const fallback = 'アップロードに失敗しました'
  if (typeof body !== 'object' || body === null) return fallback

  const { error } = body as ErrorBody
  const detail = error?.details?.find((item) => item.message)?.message
  return detail ?? error?.message ?? fallback
}

export function ImageKeyField({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | undefined>()
  const [isUploading, setIsUploading] = useState(false)

  async function handleFile(file: File) {
    setError(undefined)
    setIsUploading(true)

    try {
      const form = new FormData()
      form.append('file', file)

      /*
       * postJson は JSON 専用なので、ここだけ fetch を直に使う。
       * multipart では Content-Type をブラウザに決めさせる必要がある
       * （境界文字列を自分で組み立てないため、明示指定してはいけない）。
       */
      const response = await fetch('/api/admin/uploads', {
        method: 'POST',
        body: form,
      })
      const body: unknown = await response.json().catch(() => null)

      if (!response.ok) {
        setError(readErrorMessage(body))
        return
      }

      const data = (body as { data?: UploadSuccess } | null)?.data
      if (!data?.imageKey) {
        setError('アップロードに失敗しました')
        return
      }

      onChange(data.imageKey)
    } catch {
      setError('通信に失敗しました。時間をおいてもう一度お試しください')
    } finally {
      setIsUploading(false)
      // 同じファイルを選び直せるように値を捨てる
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-2">
      <Field id={id} label={label}>
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
      </Field>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          id={`${id}-file`}
          type="file"
          accept={ALLOWED_IMAGE_TYPES.join(',')}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void handleFile(file)
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={isUploading}
          onClick={() => fileRef.current?.click()}
        >
          {isUploading ? 'アップロード中…' : '画像をアップロード'}
        </Button>
        {value ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => onChange('')}>
            クリア
          </Button>
        ) : null}
        <span className="text-base-100/70 text-xs">
          PNG / JPEG / WebP・{maxImageMegabytes()} MB まで
        </span>
      </div>

      {value ? (
        <div className="flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- 動的生成 SVG とアップロード画像のため最適化不要 */}
          <img
            src={imageSrc(value)}
            alt=""
            width={72}
            height={101}
            className="border-base-800 rounded-lg border"
          />
          <p className="text-base-100/70 font-mono text-xs break-all">{value}</p>
        </div>
      ) : null}
    </div>
  )
}
