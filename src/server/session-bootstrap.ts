import { decode } from 'next-auth/jwt'
import { cookies } from 'next/headers'

import { serverEnv } from '@/lib/config/env.ts'
import { resolveSession } from '@/modules/auth/service.ts'
import { setSessionResolver, type SessionUser } from '@/modules/auth/session.ts'

/**
 * セッション解決の実装を登録する。
 *
 * modules/** から next/* を import しない規約のため、
 * Cookie の読み取りと JWT の復号はここ（server 層）で行い、
 * 純粋な userId / sessionId だけをドメイン層へ渡す。
 *
 * このモジュールは読み込まれた時点で登録を行う（副作用つき）。
 * instrumentation.ts だけに任せると、ビルド時のプリレンダリングなど
 * instrumentation が走らない経路で未登録のまま実行されてしまうため、
 * 実際に使う側（server/guards.ts と lib/api/with-api.ts）からも import する。
 */

/**
 * Auth.js が使用するセッション Cookie 名。
 * HTTPS 環境では __Secure- 接頭辞が付くため、両方を候補にする。
 */
const SESSION_COOKIE_NAMES = ['authjs.session-token', '__Secure-authjs.session-token'] as const

async function readSessionFromCookie(): Promise<SessionUser | null> {
  const cookieStore = await cookies()

  let rawToken: string | undefined
  let cookieName: string | undefined
  for (const name of SESSION_COOKIE_NAMES) {
    const value = cookieStore.get(name)?.value
    if (value) {
      rawToken = value
      cookieName = name
      break
    }
  }

  if (!rawToken || !cookieName) return null

  const payload = await decode({
    token: rawToken,
    secret: serverEnv().AUTH_SECRET,
    salt: cookieName,
  })

  const userId = payload?.userId
  const sessionId = payload?.sessionId
  if (typeof userId !== 'string' || typeof sessionId !== 'string') {
    return null
  }

  // 実際に有効かどうかは必ず DB で確認する。
  // JWT は「誰のどのセッションか」を運ぶだけで、権限の根拠にはしない。
  return resolveSession(userId, sessionId)
}

export function registerSessionResolver(): void {
  setSessionResolver(readSessionFromCookie)
}

// 読み込み時に登録する。複数回 import されても同じ実装を設定するだけで副作用は無い。
registerSessionResolver()
