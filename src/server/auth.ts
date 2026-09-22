import NextAuth, { type NextAuthConfig } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'

import { serverEnv } from '@/lib/config/env.ts'
import { logger } from '@/lib/observability/index.ts'
import { authenticate } from '@/modules/auth/service.ts'
import { loginSchema } from '@/modules/auth/schema.ts'

/**
 * Auth.js v5 の設定。
 *
 * ■ なぜ JWT 戦略なのか
 *   Credentials プロバイダは JWT 戦略しか選べない（Auth.js の仕様）。
 *
 * ■ JWT に何を載せるか
 *   userId と sessionId **だけ**。ロールや残高は載せない。
 *   トークンに権限を載せると、管理者がロールを剥奪しても
 *   トークンの有効期限まで古い権限で動いてしまうため。
 *
 * ■ セッションの本判定
 *   src/modules/auth/session.ts の getCurrentSession() が毎リクエストで
 *   DB を 1 回引き、セッションの失効とユーザーの状態を確認する。
 *   この構成により、停止・ロール変更・ログアウトが即座に反映される。
 */

declare module 'next-auth' {
  interface User {
    /** user_sessions.id。JWT へ引き継ぐ。 */
    sessionId?: string
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    userId?: string
    sessionId?: string
  }
}

function buildConfig(): NextAuthConfig {
  const env = serverEnv()

  return {
    // 本番では必ず HTTPS 上で動かす前提。Cookie は secure 属性つきになる。
    trustHost: true,
    secret: env.AUTH_SECRET,

    session: {
      strategy: 'jwt',
      maxAge: env.AUTH_SESSION_MAX_AGE_DAYS * 24 * 60 * 60,
    },

    pages: {
      signIn: '/login',
      error: '/login',
    },

    providers: [
      Credentials({
        id: 'credentials',
        name: 'メールアドレスとパスワード',
        credentials: {
          email: { label: 'メールアドレス', type: 'email' },
          password: { label: 'パスワード', type: 'password' },
        },
        async authorize(rawCredentials, request) {
          const parsed = loginSchema.safeParse(rawCredentials)
          if (!parsed.success) {
            // 形式不備も「認証失敗」として扱う（どの項目が悪いかを攻撃者へ与えない）
            return null
          }

          try {
            const result = await authenticate(parsed.data.email, parsed.data.password, {
              ip:
                request.headers?.get('x-forwarded-for')?.split(',')[0]?.trim() ??
                request.headers?.get('x-real-ip') ??
                null,
              userAgent: request.headers?.get('user-agent') ?? null,
            })

            return {
              id: result.userId,
              email: result.email,
              sessionId: result.sessionId,
            }
          } catch (error) {
            // 認証失敗の詳細はここで握る。Auth.js は null を「失敗」として扱う。
            logger.info('ログインに失敗しました', {
              reason: error instanceof Error ? error.message : String(error),
            })
            return null
          }
        },
      }),
    ],

    callbacks: {
      jwt({ token, user }) {
        // 初回サインイン時のみ user が渡ってくる
        if (user) {
          token.userId = user.id
          token.sessionId = user.sessionId
        }
        return token
      },

      session({ session, token }) {
        // ここで返す値は「ヒント」にすぎない。
        // 権限判定には使わず、必ず getCurrentSession() で DB を確認する。
        if (token.userId) {
          session.user.id = token.userId
        }
        return session
      },
    },
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth(buildConfig)
