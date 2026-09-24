import { beforeEach, describe, expect, it } from 'vitest'

import { UserStatus } from '@/generated/prisma/enums.ts'
import { AppError, ERROR_CODES } from '@/lib/api/errors.ts'
import { addDays, now } from '@/lib/datetime/index.ts'
import { hashPassword } from '@/modules/auth/password.ts'
import {
  authenticate,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  signup,
} from '@/modules/auth/service.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * 認証の統合テスト。
 *
 * 特に検証したいこと:
 *  - 失敗理由がユーザーへ漏れない（アカウント列挙の防止）
 *  - 停止・失効が即座に反映される
 *  - すべての試行が監査ログに残る
 */

const VALID_SIGNUP = {
  email: 'newuser@example.test',
  password: 'CorrectHorseBattery1',
  displayName: 'テスト太郎',
  acceptedTerms: true as const,
}

async function createActiveUser(
  email: string,
  password: string,
  status: UserStatus = UserStatus.ACTIVE,
) {
  const user = await testPrisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      status,
      profile: { create: { displayName: 'テストユーザー' } },
      pointAccount: { create: {} },
    },
    select: { id: true },
  })
  return user.id
}

describe('signup', () => {
  it('ユーザー・プロフィール・ポイント口座をまとめて作る', async () => {
    const result = await signup(VALID_SIGNUP)

    const user = await testPrisma.user.findUnique({
      where: { id: result.userId },
      select: {
        email: true,
        status: true,
        role: true,
        passwordHash: true,
        profile: { select: { displayName: true } },
        pointAccount: { select: { paidBalance: true, freeBalance: true } },
      },
    })

    expect(user?.email).toBe('newuser@example.test')
    expect(user?.status).toBe(UserStatus.ACTIVE)
    expect(user?.role).toBe('USER')
    expect(user?.profile?.displayName).toBe('テスト太郎')
    // 残高は 0 から始まる。付与は必ず台帳経由（Phase 3）。
    expect(user?.pointAccount?.paidBalance).toBe(0)
    expect(user?.pointAccount?.freeBalance).toBe(0)
  })

  it('パスワードを平文で保存しない', async () => {
    const result = await signup(VALID_SIGNUP)
    const user = await testPrisma.user.findUnique({
      where: { id: result.userId },
      select: { passwordHash: true },
    })

    expect(user?.passwordHash).not.toContain(VALID_SIGNUP.password)
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/)
  })

  it('監査ログへ登録を記録する', async () => {
    const result = await signup(VALID_SIGNUP)

    const log = await testPrisma.auditLog.findFirst({
      where: { action: 'USER_SIGNUP', targetId: result.userId },
    })

    expect(log).not.toBeNull()
    expect(log?.actorType).toBe('USER')
  })

  it('メールアドレスが重複したら、存在を明かさないメッセージで拒否する', async () => {
    await signup(VALID_SIGNUP)

    await expect(signup(VALID_SIGNUP)).rejects.toSatisfy((error: unknown) => {
      if (!AppError.isAppError(error)) return false
      expect(error.code).toBe(ERROR_CODES.CONFLICT)
      // 「すでに登録されています」と言わない（アカウント列挙の防止）
      expect(error.userMessage).not.toContain('登録済')
      expect(error.userMessage).not.toContain('既に')
      return true
    })
  })
})

describe('authenticate', () => {
  const PASSWORD = 'CorrectHorseBattery1'

  beforeEach(async () => {
    await createActiveUser('active@example.test', PASSWORD)
  })

  it('正しい資格情報でセッションを発行する', async () => {
    const result = await authenticate('active@example.test', PASSWORD)

    expect(result.sessionId).toBeTruthy()
    expect(result.status).toBe(UserStatus.ACTIVE)

    const session = await testPrisma.userSession.findUnique({
      where: { id: result.sessionId },
      select: { revokedAt: true, expiresAt: true },
    })
    expect(session?.revokedAt).toBeNull()
    expect(session?.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('最終ログイン日時を更新する', async () => {
    const result = await authenticate('active@example.test', PASSWORD)
    const user = await testPrisma.user.findUnique({
      where: { id: result.userId },
      select: { lastLoginAt: true },
    })
    expect(user?.lastLoginAt).not.toBeNull()
  })

  it('パスワードが違えば失敗し、理由をユーザーへ明かさない', async () => {
    await expect(authenticate('active@example.test', 'WrongPassword1234')).rejects.toSatisfy(
      (error: unknown) => {
        if (!AppError.isAppError(error)) return false
        expect(error.code).toBe(ERROR_CODES.UNAUTHENTICATED)
        expect(error.userMessage).toBe('メールアドレスまたはパスワードが正しくありません')
        // 診断情報はログ向けの meta にのみ入る
        expect(error.meta?.['reason']).toBe('password_mismatch')
        return true
      },
    )
  })

  it('存在しないユーザーでも、同じメッセージで失敗する', async () => {
    await expect(authenticate('nobody@example.test', PASSWORD)).rejects.toSatisfy(
      (error: unknown) => {
        if (!AppError.isAppError(error)) return false
        expect(error.userMessage).toBe('メールアドレスまたはパスワードが正しくありません')
        expect(error.meta?.['reason']).toBe('user_not_found')
        return true
      },
    )
  })

  it('停止中のユーザーはログインできない', async () => {
    await createActiveUser('suspended@example.test', PASSWORD, UserStatus.SUSPENDED)

    await expect(authenticate('suspended@example.test', PASSWORD)).rejects.toSatisfy(
      (error: unknown) => {
        if (!AppError.isAppError(error)) return false
        expect(error.meta?.['reason']).toBe('status_suspended')
        return true
      },
    )
  })

  it('失敗した試行も監査ログに残る', async () => {
    await expect(authenticate('active@example.test', 'WrongPassword1234')).rejects.toThrow()

    const log = await testPrisma.auditLog.findFirst({
      where: { action: 'USER_LOGIN_FAILED' },
    })
    expect(log).not.toBeNull()
  })

  it('セッション発行時も監査ログに残る', async () => {
    await authenticate('active@example.test', PASSWORD)

    const log = await testPrisma.auditLog.findFirst({ where: { action: 'USER_LOGIN' } })
    expect(log).not.toBeNull()
  })
})

describe('resolveSession', () => {
  const PASSWORD = 'CorrectHorseBattery1'

  it('有効なセッションを解決する', async () => {
    await createActiveUser('resolve@example.test', PASSWORD)
    const auth = await authenticate('resolve@example.test', PASSWORD)

    const session = await resolveSession(auth.userId, auth.sessionId)

    expect(session).not.toBeNull()
    expect(session?.id).toBe(auth.userId)
    expect(session?.status).toBe(UserStatus.ACTIVE)
  })

  it('失効したセッションは解決しない', async () => {
    await createActiveUser('revoked@example.test', PASSWORD)
    const auth = await authenticate('revoked@example.test', PASSWORD)

    await revokeSession(auth.sessionId, 'テスト')

    expect(await resolveSession(auth.userId, auth.sessionId)).toBeNull()
  })

  it('期限切れのセッションは解決しない', async () => {
    const userId = await createActiveUser('expired@example.test', PASSWORD)
    const expired = await testPrisma.userSession.create({
      data: {
        userId,
        expiresAt: addDays(now(), -1),
      },
      select: { id: true },
    })

    expect(await resolveSession(userId, expired.id)).toBeNull()
  })

  it('別ユーザーのセッション ID では解決しない', async () => {
    await createActiveUser('owner@example.test', PASSWORD)
    const other = await createActiveUser('other@example.test', PASSWORD)
    const auth = await authenticate('owner@example.test', PASSWORD)

    expect(await resolveSession(other, auth.sessionId)).toBeNull()
  })

  it('停止されたユーザーのセッションは「停止中」として解決される', async () => {
    const userId = await createActiveUser('tobesuspended@example.test', PASSWORD)
    const auth = await authenticate('tobesuspended@example.test', PASSWORD)

    await testPrisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.SUSPENDED },
    })

    const session = await resolveSession(auth.userId, auth.sessionId)

    // null ではなく SUSPENDED を返す。
    // 呼び出し側が「未ログイン」と区別して正しい案内を出せるようにするため。
    expect(session?.status).toBe(UserStatus.SUSPENDED)
  })

  it('退会済みユーザーのセッションは解決しない', async () => {
    const userId = await createActiveUser('withdrawn@example.test', PASSWORD)
    const auth = await authenticate('withdrawn@example.test', PASSWORD)

    await testPrisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.WITHDRAWN, deletedAt: now() },
    })

    expect(await resolveSession(auth.userId, auth.sessionId)).toBeNull()
  })
})

describe('revokeAllSessions', () => {
  const PASSWORD = 'CorrectHorseBattery1'

  it('複数端末のセッションをまとめて失効させる', async () => {
    const userId = await createActiveUser('multi@example.test', PASSWORD)
    const first = await authenticate('multi@example.test', PASSWORD)
    const second = await authenticate('multi@example.test', PASSWORD)

    const count = await revokeAllSessions(userId, 'テストによる一括失効')

    expect(count).toBe(2)
    expect(await resolveSession(userId, first.sessionId)).toBeNull()
    expect(await resolveSession(userId, second.sessionId)).toBeNull()
  })

  it('失効させるセッションが無ければ監査ログを書かない', async () => {
    const userId = await createActiveUser('nosession@example.test', PASSWORD)

    const count = await revokeAllSessions(userId, 'テスト')

    expect(count).toBe(0)
    const log = await testPrisma.auditLog.findFirst({
      where: { action: 'USER_SESSIONS_REVOKED' },
    })
    expect(log).toBeNull()
  })
})
