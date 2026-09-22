import type { UserStatus } from '@/generated/prisma/enums.ts'
import { cn } from '@/lib/utils.ts'

const USER_STATUS_LABELS: Record<UserStatus, { label: string; className: string }> = {
  ACTIVE: { label: '利用中', className: 'bg-emerald-500/15 text-emerald-300' },
  SUSPENDED: { label: '停止中', className: 'bg-red-500/15 text-red-300' },
  WITHDRAWN: { label: '退会済み', className: 'bg-base-700/40 text-base-100' },
}

/**
 * 状態バッジ。
 * 色だけに依存せず、必ずテキストラベルを併記する（アクセシビリティ要件）。
 */
export function UserStatusBadge({ status }: { status: UserStatus }) {
  const { label, className } = USER_STATUS_LABELS[status]
  return (
    <span
      className={cn('inline-block rounded-full px-2.5 py-0.5 text-xs font-bold', className)}
    >
      {label}
    </span>
  )
}
