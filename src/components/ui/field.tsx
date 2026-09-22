import * as React from 'react'

import { cn } from '@/lib/utils.ts'

/**
 * ラベル・入力・エラーをまとめる。
 *
 * エラーは aria-describedby で入力欄と結び付け、role="alert" で読み上げさせる。
 * 色だけでエラーを示さない（アクセシビリティ要件）。
 */
export function Field({
  id,
  label,
  error,
  hint,
  required,
  children,
  className,
}: {
  id: string
  label: string
  error?: string | undefined
  hint?: string | undefined
  required?: boolean
  children: React.ReactNode
  className?: string
}) {
  const errorId = `${id}-error`
  const hintId = `${id}-hint`

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="text-base-100 block text-sm font-medium">
        {label}
        {required ? (
          <span className="text-accent-400 ml-1" aria-hidden="true">
            *
          </span>
        ) : null}
        {required ? <span className="sr-only">（必須）</span> : null}
      </label>
      {children}
      {hint ? (
        <p id={hintId} className="text-base-100/70 text-xs">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  )
}
