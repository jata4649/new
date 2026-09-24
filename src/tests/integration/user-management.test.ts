import { describe, expect, it } from 'vitest'

import { Role, UserStatus } from '@/generated/prisma/enums.ts'
import { AppError, ERROR_CODES } from '@/lib/api/errors.ts'
import { hashPassword } from '@/modules/auth/password.ts'
import { authenticate, resolveSession } from '@/modules/auth/service.ts'
import { getMyProfile } from '@/modules/users/me.ts'
import { userListQuerySchema } from '@/modules/users/schema.ts'
import { getUserDetail, listUsers, updateUserStatus } from '@/modules/users/service.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * ユーザー管理（管理画面）の統合テスト。
 *
 * 特に検証したいこと:
 *  - 停止した瞬間に、ログイン中の端末が締め出されること
 *  - 理由が監査ログへ残ること
 *  - パスワードハッシュがどの経路でも返らないこと
 */

const PASSWORD = 'CorrectHorseBattery1'

async function createUser(options: {
  email: string
  displayName?: string
  role?: Role
  status?: UserStatus
}) {
  return testPrisma.user.create({
    data: {
      email: options.email,
      passwordHash: await hashPassword(PASSWORD),
      role: options.role ?? Role.USER,
      status: options.status ?? UserStatus.ACTIVE,
      profile: { create: { displayName: options.displayName ?? 'テストユーザー' } },
      pointAccount: { create: {} },
    },
    select: { id: true, role: true },
  })
}

const defaultQuery = userListQuerySchema.parse({})

describe('listUsers', () => {
  it('作成日の新しい順に返し、件数を数える', async () => {
    await createUser({ email: 'first@example.test', displayName: '一人目' })
    await createUser({ email: 'second@example.test', displayName: '二人目' })

    const result = await listUsers(defaultQuery)

    expect(result.total).toBe(2)
    expect(result.items[0]?.displayName).toBe('二人目')
    expect(result.items[1]?.displayName).toBe('一人目')
  })

  it('パスワードハッシュを返さない', async () => {
    await createUser({ email: 'secret@example.test' })

    const result = await listUsers(defaultQuery)

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('argon2')
    expect(serialized).not.toContain('passwordHash')
  })

  it('ステータスで絞り込める', async () => {
    await createUser({ email: 'active@example.test' })
    await createUser({ email: 'suspended@example.test', status: UserStatus.SUSPENDED })

    const result = await listUsers({ ...defaultQuery, status: UserStatus.SUSPENDED })

    expect(result.total).toBe(1)
    expect(result.items[0]?.email).toBe('suspended@example.test')
  })

  it('メールアドレス・表示名で部分一致検索できる（大文字小文字を区別しない）', async () => {
    await createUser({ email: 'taro@example.test', displayName: '山田太郎' })
    await createUser({ email: 'hanako@example.test', displayName: '鈴木花子' })

    const byName = await listUsers({ ...defaultQuery, q: '太郎' })
    expect(byName.total).toBe(1)

    const byEmail = await listUsers({ ...defaultQuery, q: 'HANAKO' })
    expect(byEmail.total).toBe(1)
  })

  it('退会済み（論理削除）のユーザーは一覧に出ない', async () => {
    const user = await createUser({ email: 'gone@example.test' })
    await testPrisma.user.update({
      where: { id: user.id },
      data: { status: UserStatus.WITHDRAWN, deletedAt: new Date() },
    })

    const result = await listUsers(defaultQuery)
    expect(result.total).toBe(0)
  })

  it('ページングが機能する', async () => {
    for (let i = 0; i < 5; i++) {
      await createUser({ email: `user${i}@example.test` })
    }

    const page1 = await listUsers({ ...defaultQuery, perPage: 2, page: 1 })
    const page3 = await listUsers({ ...defaultQuery, perPage: 2, page: 3 })

    expect(page1.items).toHaveLength(2)
    expect(page1.totalPages).toBe(3)
    expect(page3.items).toHaveLength(1)
  })
})

describe('getUserDetail', () => {
  it('存在しないユーザーで NOT_FOUND を返す', async () => {
    await expect(getUserDetail('does-not-exist')).rejects.toSatisfy((error: unknown) => {
      if (!AppError.isAppError(error)) return false
      expect(error.code).toBe(ERROR_CODES.NOT_FOUND)
      return true
    })
  })

  it('有効なセッション数を数える', async () => {
    const user = await createUser({ email: 'sessions@example.test' })
    await authenticate('sessions@example.test', PASSWORD)
    await authenticate('sessions@example.test', PASSWORD)

    const detail = await getUserDetail(user.id)
    expect(detail.activeSessionCount).toBe(2)
  })
})

describe('updateUserStatus', () => {
  it('停止すると、ログイン中のセッションが即座に失効する', async () => {
    const admin = await createUser({ email: 'admin@example.test', role: Role.ADMIN })
    const target = await createUser({ email: 'target@example.test' })

    const session = await authenticate('target@example.test', PASSWORD)
    // 停止前はセッションが有効
    expect(await resolveSession(target.id, session.sessionId)).not.toBeNull()

    await updateUserStatus(
      target.id,
      { status: UserStatus.SUSPENDED, reason: '不正利用の疑いによる一時停止' },
      { id: admin.id, role: admin.role },
    )

    // 停止した瞬間に締め出される
    expect(await resolveSession(target.id, session.sessionId)).toBeNull()
  })

  it('理由を監査ログへ変更前後とともに記録する', async () => {
    const admin = await createUser({ email: 'admin@example.test', role: Role.ADMIN })
    const target = await createUser({ email: 'target@example.test' })

    await updateUserStatus(
      target.id,
      { status: UserStatus.SUSPENDED, reason: '規約違反の報告を受けたため' },
      { id: admin.id, role: admin.role },
    )

    const log = await testPrisma.auditLog.findFirst({
      where: { action: 'USER_SUSPEND', targetId: target.id },
    })

    expect(log?.actorType).toBe('ADMIN')
    expect(log?.actorId).toBe(admin.id)
    expect(log?.reason).toBe('規約違反の報告を受けたため')
    expect(log?.before).toEqual({ status: 'ACTIVE' })
    expect(log?.after).toEqual({ status: 'SUSPENDED' })
  })

  it('自分自身のステータスは変更できない（管理画面からの締め出し防止）', async () => {
    const admin = await createUser({ email: 'admin@example.test', role: Role.ADMIN })

    await expect(
      updateUserStatus(
        admin.id,
        { status: UserStatus.SUSPENDED, reason: '自分を停止しようとするテスト' },
        { id: admin.id, role: admin.role },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      if (!AppError.isAppError(error)) return false
      expect(error.code).toBe(ERROR_CODES.CONFLICT)
      return true
    })
  })

  it('すでに同じステータスなら拒否する', async () => {
    const admin = await createUser({ email: 'admin@example.test', role: Role.ADMIN })
    const target = await createUser({ email: 'target@example.test' })

    await expect(
      updateUserStatus(
        target.id,
        { status: UserStatus.ACTIVE, reason: 'すでに利用中のはずのユーザー' },
        { id: admin.id, role: admin.role },
      ),
    ).rejects.toThrow()
  })

  it('退会処理では deletedAt を設定する（物理削除しない）', async () => {
    const admin = await createUser({ email: 'admin@example.test', role: Role.ADMIN })
    const target = await createUser({ email: 'target@example.test' })

    await updateUserStatus(
      target.id,
      { status: UserStatus.WITHDRAWN, reason: '本人からの退会申し出' },
      { id: admin.id, role: admin.role },
    )

    const user = await testPrisma.user.findUnique({
      where: { id: target.id },
      select: { status: true, deletedAt: true },
    })

    // 行は残っている（台帳・抽選履歴との整合を保つため）
    expect(user).not.toBeNull()
    expect(user?.status).toBe(UserStatus.WITHDRAWN)
    expect(user?.deletedAt).not.toBeNull()
  })

  it('停止から利用中へ戻すと REACTIVATE として記録される', async () => {
    const admin = await createUser({ email: 'admin@example.test', role: Role.ADMIN })
    const target = await createUser({
      email: 'target@example.test',
      status: UserStatus.SUSPENDED,
    })

    await updateUserStatus(
      target.id,
      { status: UserStatus.ACTIVE, reason: '調査の結果、問題が無いと判明したため' },
      { id: admin.id, role: admin.role },
    )

    const log = await testPrisma.auditLog.findFirst({
      where: { action: 'USER_REACTIVATE', targetId: target.id },
    })
    expect(log).not.toBeNull()
  })
})

describe('getMyProfile', () => {
  it('自分の残高と基本情報を返す（パスワードハッシュは含まない）', async () => {
    const user = await createUser({ email: 'me@example.test', displayName: '自分' })

    const profile = await getMyProfile(user.id)

    expect(profile.email).toBe('me@example.test')
    expect(profile.displayName).toBe('自分')
    expect(profile.points).toEqual({ paid: 0, free: 0, total: 0 })
    expect(JSON.stringify(profile)).not.toContain('argon2')
  })

  it('退会済みユーザーは取得できない', async () => {
    const user = await createUser({ email: 'gone@example.test' })
    await testPrisma.user.update({
      where: { id: user.id },
      data: { status: UserStatus.WITHDRAWN, deletedAt: new Date() },
    })

    await expect(getMyProfile(user.id)).rejects.toThrow()
  })
})
