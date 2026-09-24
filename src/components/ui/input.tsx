import * as React from 'react'

import { cn } from '@/lib/utils.ts'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

/**
 * 入力欄。
 * フォントサイズを 16px 以上にして、iOS Safari での自動ズームを防ぐ。
 */
export function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cn(
        'border-base-700 bg-base-900 text-base-50 h-11 w-full rounded-lg border px-3 text-base',
        'placeholder:text-base-700',
        'focus-visible:outline-accent-400 focus-visible:outline-2 focus-visible:outline-offset-1',
        'aria-[invalid=true]:border-red-500',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
