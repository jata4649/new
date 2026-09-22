import * as React from 'react'

import { cn } from '@/lib/utils.ts'

/** 画面全体に対する通知。エラーは role="alert" で即座に読み上げさせる。 */
export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'error' | 'success' | 'warning'
  title?: string
  children?: React.ReactNode
  className?: string
}) {
  const tones = {
    info: 'border-base-700 bg-base-900 text-base-50',
    error: 'border-red-500/60 bg-red-950/40 text-red-100',
    success: 'border-emerald-500/60 bg-emerald-950/40 text-emerald-100',
    warning: 'border-amber-500/60 bg-amber-950/40 text-amber-100',
  } as const

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('rounded-lg border px-4 py-3 text-sm', tones[tone], className)}
    >
      {title ? <p className="font-bold">{title}</p> : null}
      {children ? <div className={title ? 'mt-1' : undefined}>{children}</div> : null}
    </div>
  )
}
