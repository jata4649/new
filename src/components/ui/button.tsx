import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils.ts'

/**
 * ボタン。
 *
 * アクセシビリティ要件:
 *  - フォーカスリングを必ず表示する（キーボード操作への配慮）
 *  - disabled 時もコントラストを保つ
 *  - タップ領域を 44px 以上にする（スマートフォンファースト）
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-bold transition-colors ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 ' +
    'disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-accent-500 text-base-950 hover:bg-accent-400',
        secondary: 'bg-base-800 text-base-50 hover:bg-base-700',
        outline: 'border border-base-700 text-base-50 hover:bg-base-800',
        danger: 'bg-red-600 text-white hover:bg-red-500',
        ghost: 'text-base-100 hover:bg-base-800',
      },
      size: {
        sm: 'h-9 px-3',
        md: 'h-11 px-4',
        lg: 'h-12 px-6 text-base',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { buttonVariants }
