import * as React from 'react'

import { cn } from '@/lib/utils.ts'

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-card border-base-800 bg-base-900 border p-4', className)}
      {...props}
    />
  )
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-base-100 text-sm font-bold', className)} {...props} />
}
