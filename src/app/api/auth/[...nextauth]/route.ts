import { handlers } from '@/server/auth.ts'

/**
 * Auth.js のエンドポイント（ログイン・ログアウト・CSRF トークン）。
 *
 * ここは Auth.js が提供するハンドラをそのまま公開する。
 * 認可の判定はこのルートではなく withApi 側で行う。
 */
export const runtime = 'nodejs'

export const { GET, POST } = handlers
