import type { Role, UserStatus } from '@/generated/prisma/enums.ts'

/**
 * セッション解決のインターフェース。
 *
 * ★Phase 1 では実装しない（Phase 2「認証・ユーザー・RBAC」で実装する）。
 *   ここでは withApi が依存する型と入口だけを確定させ、
 *   Phase 2 の実装がこのシグネチャを満たせばよい状態にしている。
 *
 * ■ 採用する方式（Phase 2 の実装方針）
 *   Auth.js v5 の Credentials プロバイダは JWT 戦略しか選べないため、
 *   「管理者が停止した瞬間にログアウトさせる」には JWT だけでは足りない。
 *   そこで次の構成にする:
 *
 *     1. JWT には userId と sessionId（user_sessions.id）だけを載せる
 *     2. getCurrentSession() は毎リクエストで DB を 1 回引き、
 *        - user_sessions が失効・取消しされていないか
 *        - users.status が ACTIVE か
 *        - users.role が何か
 *        を確認する
 *     3. 停止・退会・セッション取消しは即座に反映される
 *
 *   JWT の「DB を引かなくてよい」利点は捨てることになるが、
 *   金銭を扱う以上、権限と停止の即時反映を優先する。
 *   （残高・在庫は結局 DB を引くので、追加コストは実質 1 クエリ）
 */

export interface SessionUser {
  id: string
  email: string
  role: Role
  status: UserStatus
  /** user_sessions.id。失効判定とログアウト時の取消しに使う。 */
  sessionId: string
}

export class SessionNotImplementedError extends Error {
  constructor() {
    super(
      'セッション解決は Phase 2（認証）で実装します。' +
        'Phase 1 の時点で認証必須の API を呼び出すことはできません。',
    )
    this.name = 'SessionNotImplementedError'
  }
}

type SessionResolver = () => Promise<SessionUser | null>

let resolver: SessionResolver | null = null

/**
 * Phase 2 の認証実装、またはテストからセッション解決を差し込む。
 */
export function setSessionResolver(next: SessionResolver): void {
  resolver = next
}

export function resetSessionResolver(): void {
  resolver = null
}

export async function getCurrentSession(): Promise<SessionUser | null> {
  if (!resolver) {
    throw new SessionNotImplementedError()
  }
  return resolver()
}
