import Link from 'next/link'

import { LogoutButton } from '@/components/auth/logout-button.tsx'
import { publicEnv } from '@/lib/config/env.ts'
import { isAdminRole } from '@/lib/auth/permissions.ts'
import { getOptionalSession } from '@/server/guards.ts'

/**
 * 会員エリアの共通レイアウト。
 * ここでは表示の出し分けのみを行い、認可の判定は各ページの requireUser() で行う。
 */
export default async function UserLayout({ children }: { children: React.ReactNode }) {
  const session = await getOptionalSession()

  return (
    <div className="min-h-dvh">
      <header className="border-base-800 border-b">
        <nav className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-3">
          <Link href="/" className="text-sm font-bold">
            {publicEnv.NEXT_PUBLIC_SITE_NAME}
          </Link>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {session ? (
              <>
                {isAdminRole(session.role) ? (
                  <Link href="/admin" className="text-accent-400 underline">
                    管理画面
                  </Link>
                ) : null}
                <LogoutButton />
              </>
            ) : (
              <Link href="/login" className="text-accent-400 underline">
                ログイン
              </Link>
            )}
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
    </div>
  )
}
