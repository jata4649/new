import Link from 'next/link'

import { LogoutButton } from '@/components/auth/logout-button.tsx'
import { hasPermission, PERMISSIONS, type Permission } from '@/lib/auth/permissions.ts'
import { requireAdmin } from '@/server/guards.ts'

/**
 * 管理画面の共通レイアウト。
 *
 * ここで requireAdmin() を呼ぶことで、配下のすべてのページが
 * 「ログイン済み・ACTIVE・管理ロール」であることを保証される。
 * ただし個別ページでも必要な権限を明示的に確認すること
 * （レイアウトの変更が認可の抜けにならないようにするため）。
 *
 * ナビゲーションは権限に応じて出し分けるが、これは利便性のためであり
 * 認可ではない。実際の判定は各ページと API で行う。
 */

const NAV_ITEMS: { href: string; label: string; permission: Permission; phase?: string }[] = [
  { href: '/admin', label: 'ダッシュボード', permission: PERMISSIONS.USER_READ },
  { href: '/admin/users', label: 'ユーザー管理', permission: PERMISSIONS.USER_READ },
  { href: '/admin/inventories', label: '在庫管理', permission: PERMISSIONS.INVENTORY_READ },
  { href: '/admin/oripas', label: 'オリパ管理', permission: PERMISSIONS.ORIPA_READ },
  {
    href: '/admin/shipping-requests',
    label: '発送管理',
    permission: PERMISSIONS.SHIPPING_READ,
    phase: 'Phase 7',
  },
  {
    href: '/admin/audit-logs',
    label: '監査ログ',
    permission: PERMISSIONS.AUDIT_READ,
    phase: 'Phase 8',
  },
]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin()

  const visibleItems = NAV_ITEMS.filter((item) => hasPermission(session.role, item.permission))

  return (
    <div className="min-h-dvh">
      <header className="border-base-800 bg-base-900 border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
          <Link href="/admin" className="text-sm font-bold">
            管理画面
          </Link>
          <span className="bg-base-800 text-base-100 rounded px-2 py-0.5 text-xs">
            {session.role}
          </span>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <Link href="/mypage" className="text-accent-400 underline">
              ユーザー画面
            </Link>
            <LogoutButton />
          </div>
        </div>
        <nav aria-label="管理メニュー" className="mx-auto max-w-5xl px-4 pb-2">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {visibleItems.map((item) => (
              <li key={item.href}>
                {item.phase ? (
                  <span className="text-base-700" title={`${item.phase} で実装予定`}>
                    {item.label}
                    <span className="ml-1 text-xs">({item.phase})</span>
                  </span>
                ) : (
                  <Link href={item.href} className="text-base-100 hover:text-accent-400">
                    {item.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  )
}
