import { Prisma } from '@/generated/prisma/client.ts'
import { Role, UserStatus } from '@/generated/prisma/enums.ts'
import { AppError, ERROR_CODES, errors } from '@/lib/api/errors.ts'
import { serverEnv } from '@/lib/config/env.ts'
import { addDays, now } from '@/lib/datetime/index.ts'
import { AUDIT_ACTIONS, AUDIT_TARGETS, writeAuditLog } from '@/modules/audit/service.ts'
import { prisma, TRANSACTION_OPTIONS } from '@/server/db.ts'

import { hashPassword, verifyPassword } from './password.ts'
import type { SignupInput } from './schema.ts'
import type { SessionUser } from './session.ts'

/**
 * 認証のドメインサービス。
 *
 * ■ セッション方式
 *   Auth.js の Credentials プロバイダは JWT 戦略しか選べない。
 *   しかし「管理者が停止した瞬間にログアウトさせる」には JWT だけでは足りないため、
 *   JWT には userId と sessionId だけを載せ、毎リクエストで DB を 1 回引いて
 *   「セッションが生きているか」「ユーザーが ACTIVE か」「ロールは何か」を確認する。
 *
 * ■ アカウント列挙の防止
 *   「メールアドレスが存在しない」と「パスワードが違う」を区別してユーザーへ返さない。
 *   どちらも同じ失敗として扱い、処理時間も揃える（存在しない場合もハッシュ検証を行う）。
 */

/**
 * 実在しないユーザーに対してもパスワード検証を行うためのダミーハッシュ。
 * 応答時間の差からアカウントの有無が推測されるのを防ぐ。
 * 検証には必ず失敗する（このハッシュに対応する平文は保持していない）。
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdGZvcnRpbWluZ2F0dGFja3M$Zm9yY2VkVG9GYWlsVmVyaWZpY2F0aW9uQ2hlY2s'

export interface RequestContext {
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

export interface SignupResult {
  userId: string
  email: string
}

/**
 * 新規会員登録。
 *
 * ユーザー・プロフィール・ポイント口座・監査ログを 1 トランザクションで作る。
 * ポイント残高は 0 で作り、付与は必ず台帳経由で行う（Phase 3）。
 */
export async function signup(
  input: SignupInput,
  context: RequestContext = {},
): Promise<SignupResult> {
  const passwordHash = await hashPassword(input.password)

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          role: Role.USER,
          status: UserStatus.ACTIVE,
          profile: { create: { displayName: input.displayName } },
          pointAccount: { create: {} },
        },
        select: { id: true, email: true },
      })

      await writeAuditLog(
        {
          actorType: 'USER',
          actorId: user.id,
          action: AUDIT_ACTIONS.USER_SIGNUP,
          targetType: AUDIT_TARGETS.USER,
          targetId: user.id,
          after: { email: user.email, displayName: input.displayName },
          ip: context.ip,
          userAgent: context.userAgent,
          requestId: context.requestId,
        },
        tx,
      )

      return { userId: user.id, email: user.email }
    }, TRANSACTION_OPTIONS)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // メールアドレスの重複。
      // 「登録済みかどうか」を返すとアカウント列挙になるため、
      // 汎用的なメッセージにとどめる。
      throw new AppError(
        ERROR_CODES.CONFLICT,
        409,
        'このメールアドレスでは登録できません。別のアドレスをお試しください',
        { meta: { reason: 'email_already_exists' } },
      )
    }
    throw error
  }
}

export interface AuthenticateResult {
  userId: string
  sessionId: string
  role: Role
  status: UserStatus
  email: string
}

/**
 * メールアドレスとパスワードで認証し、セッションを 1 件発行する。
 *
 * 失敗理由（存在しない / パスワード不一致 / 停止中）はすべて同じエラーで返す。
 * 詳細は meta に入れてサーバーログにのみ残す。
 */
export async function authenticate(
  email: string,
  password: string,
  context: RequestContext = {},
): Promise<AuthenticateResult> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      role: true,
      status: true,
      deletedAt: true,
    },
  })

  // ユーザーが存在しない場合もハッシュ検証を行い、応答時間を揃える
  const passwordMatches = await verifyPassword(
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    password,
  )

  const failureReason =
    !user || user.deletedAt !== null
      ? 'user_not_found'
      : !passwordMatches
        ? 'password_mismatch'
        : user.status !== UserStatus.ACTIVE
          ? `status_${user.status.toLowerCase()}`
          : null

  if (failureReason !== null) {
    await writeAuditLog({
      actorType: 'SYSTEM',
      actorId: user?.id ?? null,
      action: AUDIT_ACTIONS.USER_LOGIN_FAILED,
      targetType: AUDIT_TARGETS.USER,
      targetId: user?.id ?? null,
      // メールアドレスは監査のために残す（ログイン試行の追跡に必要）
      after: { email, reason: failureReason },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    }).catch(() => {
      // 監査ログの失敗で認証処理を止めない（失敗はどのみち返す）
    })

    throw new AppError(
      ERROR_CODES.UNAUTHENTICATED,
      401,
      'メールアドレスまたはパスワードが正しくありません',
      { meta: { reason: failureReason } },
    )
  }

  // ここへ到達する時点で user は非 null（failureReason が null であることが保証する）
  if (!user) {
    throw errors.internal(new Error('認証結果の整合性が取れていません'))
  }

  const env = serverEnv()
  const issuedAt = now()

  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.userSession.create({
      data: {
        userId: user.id,
        userAgent: context.userAgent ?? null,
        ip: context.ip ?? null,
        issuedAt,
        lastSeenAt: issuedAt,
        expiresAt: addDays(issuedAt, env.AUTH_SESSION_MAX_AGE_DAYS),
      },
      select: { id: true },
    })

    await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: issuedAt },
    })

    await writeAuditLog(
      {
        actorType: 'USER',
        actorId: user.id,
        action: AUDIT_ACTIONS.USER_LOGIN,
        targetType: AUDIT_TARGETS.USER,
        targetId: user.id,
        after: { sessionId: created.id },
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      },
      tx,
    )

    return created
  }, TRANSACTION_OPTIONS)

  return {
    userId: user.id,
    sessionId: session.id,
    role: user.role,
    status: user.status,
    email: user.email,
  }
}

/**
 * JWT に載っている userId / sessionId から、現在有効なセッションを解決する。
 *
 * ここが「停止の即時反映」を実現している箇所。
 * セッションが失効・取消し済み、またはユーザーが ACTIVE でない場合は null を返す。
 */
export async function resolveSession(
  userId: string,
  sessionId: string,
): Promise<SessionUser | null> {
  const session = await prisma.userSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      revokedAt: true,
      user: {
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          deletedAt: true,
        },
      },
    },
  })

  if (!session || session.userId !== userId) return null
  if (session.revokedAt !== null) return null
  if (session.expiresAt.getTime() <= now().getTime()) return null
  if (session.user.deletedAt !== null) return null

  return {
    id: session.user.id,
    email: session.user.email,
    role: session.user.role,
    // 停止中かどうかの判定は withApi 側で行う。
    // ここで null を返してしまうと「ログインしていない」と区別が付かず、
    // 「停止されています」という正しい案内を出せなくなるため。
    status: session.user.status,
    sessionId: session.id,
  }
}

/** ログアウト（該当セッションのみ失効させる） */
export async function revokeSession(
  sessionId: string,
  reason: string,
  context: RequestContext = {},
): Promise<void> {
  const session = await prisma.userSession.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, revokedAt: true },
  })

  if (!session || session.revokedAt !== null) return

  await prisma.$transaction(async (tx) => {
    await tx.userSession.update({
      where: { id: sessionId },
      data: { revokedAt: now(), revokedReason: reason },
    })

    await writeAuditLog(
      {
        actorType: 'USER',
        actorId: session.userId,
        action: AUDIT_ACTIONS.USER_LOGOUT,
        targetType: AUDIT_TARGETS.USER,
        targetId: session.userId,
        after: { sessionId, reason },
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      },
      tx,
    )
  }, TRANSACTION_OPTIONS)
}

/**
 * ユーザーの全セッションを失効させる。
 * 「他の端末からログアウト」および管理者による停止処理から呼ばれる。
 */
export async function revokeAllSessions(
  userId: string,
  reason: string,
  options: { actorId?: string | null; actorType?: 'USER' | 'ADMIN' } & RequestContext = {},
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now(), revokedReason: reason },
    })

    if (result.count > 0) {
      await writeAuditLog(
        {
          actorType: options.actorType ?? 'USER',
          actorId: options.actorId ?? userId,
          action: AUDIT_ACTIONS.USER_SESSIONS_REVOKED,
          targetType: AUDIT_TARGETS.USER,
          targetId: userId,
          reason,
          after: { revokedCount: result.count },
          ip: options.ip,
          userAgent: options.userAgent,
          requestId: options.requestId,
        },
        tx,
      )
    }

    return result.count
  }, TRANSACTION_OPTIONS)
}

/** セッションの最終アクセス時刻を更新する（失敗してもリクエストは止めない） */
export async function touchSession(sessionId: string): Promise<void> {
  try {
    await prisma.userSession.update({
      where: { id: sessionId },
      data: { lastSeenAt: now() },
    })
  } catch {
    // 最終アクセス時刻は表示用の情報であり、更新失敗は無視してよい
  }
}
