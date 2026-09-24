import { redirect } from 'next/navigation'

import { isAdminRole, hasPermission, type Permission } from '@/lib/auth/permissions.ts'
import { getCurrentSession, type SessionUser } from '@/modules/auth/session.ts'

// セッション解決の実装を登録する（副作用つき import）
import '@/server/session-bootstrap.ts'

/**
 * Server Component 用の認可ガード。
 *
 * 要件: 「認可チェックを必ずサーバー側で行う」
 *
 * Route Handler 側は withApi が同じ判定を行う。
 * 画面（RSC）とAPI で判定ロジックを共有するため、どちらも
 * lib/auth/permissions.ts の ROLE_PERMISSIONS を唯一の根拠にしている。
 *
 * Proxy（src/proxy.ts）での判定は認可の根拠にしない。
 * Edge ランタイムでは DB を引けず、停止状態やロールを確認できないため。
 */

/** ログイン必須。未ログインならログイン画面へ送る。 */
export async function requireUser(callbackUrl?: string): Promise<SessionUser> {
  const session = await getCurrentSession()

  if (!session) {
    const target = callbackUrl
      ? `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`
      : '/login'
    redirect(target)
  }

  if (session.status !== 'ACTIVE') {
    // 停止中であることを伝える専用画面へ送る。
    // 「ログインしていない」と同じ扱いにすると、利用者が原因を理解できない。
    redirect('/suspended')
  }

  return session
}

/** 管理画面へのアクセス。ロールが不足していればトップへ戻す。 */
export async function requireAdmin(permission?: Permission): Promise<SessionUser> {
  const session = await requireUser('/admin')

  if (!isAdminRole(session.role)) {
    // 管理画面の存在自体を隠すため、403 ではなく 404 相当の扱いにする
    redirect('/')
  }

  if (permission && !hasPermission(session.role, permission)) {
    redirect('/admin')
  }

  return session
}

/** ログイン済みかどうかだけを知りたい場合（リダイレクトしない） */
export async function getOptionalSession(): Promise<SessionUser | null> {
  return getCurrentSession()
}
