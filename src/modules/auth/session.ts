import type { Role, UserStatus } from '@/generated/prisma/enums.ts'

/**
 * セッション解決。
 *
 * ■ 採用している方式
 *   Auth.js v5 の Credentials プロバイダは JWT 戦略しか選べないため、
 *   「管理者が停止した瞬間にログアウトさせる」には JWT だけでは足りない。
 *   そこで次の構成にしている:
 *
 *     1. JWT には userId と sessionId（user_sessions.id）だけを載せる
 *     2. getCurrentSession() が毎リクエストで DB を 1 回引き、
 *        - user_sessions が失効・取消しされていないか
 *        - users.status が何か
 *        - users.role が何か
 *        を確認する
 *     3. 停止・退会・ロール変更・セッション取消しが即座に反映される
 *
 *   JWT の「DB を引かなくてよい」利点は捨てているが、
 *   残高・在庫の確認で結局 DB を引くため追加コストは実質 1 クエリ。
 *
 * ■ このファイルが resolver を差し替え可能にしている理由
 *   - modules/** は next/* に依存させない（ドメイン層を HTTP から独立させる）
 *   - テストから任意のセッションを注入できるようにする
 *   実装の注入は src/server/session-bootstrap.ts が行う。
 */

export interface SessionUser {
  id: string
  email: string
  role: Role
  /**
   * ACTIVE 以外も返る。停止中であることを呼び出し側（withApi）が
   * 「ログインしていない」と区別して正しく案内できるようにするため。
   */
  status: UserStatus
  /** user_sessions.id。失効判定とログアウト時の取消しに使う。 */
  sessionId: string
}

export class SessionResolverNotConfiguredError extends Error {
  constructor() {
    super(
      'セッション解決の実装が登録されていません。' +
        'サーバー側のエントリポイントで registerSessionResolver() を呼び出してください。',
    )
    this.name = 'SessionResolverNotConfiguredError'
  }
}

type SessionResolver = () => Promise<SessionUser | null>

let resolver: SessionResolver | null = null

/** 実装（またはテスト用のスタブ）を登録する */
export function setSessionResolver(next: SessionResolver): void {
  resolver = next
}

export function resetSessionResolver(): void {
  resolver = null
}

export async function getCurrentSession(): Promise<SessionUser | null> {
  if (!resolver) {
    throw new SessionResolverNotConfiguredError()
  }
  return resolver()
}
