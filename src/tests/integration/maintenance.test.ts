import { beforeEach, describe, expect, it } from 'vitest'

import { addDays, now } from '@/lib/datetime/index.ts'
import { listAuditLogs, listRecordedActions } from '@/modules/audit/queries.ts'
import { AUDIT_ACTIONS, writeAuditLog } from '@/modules/audit/service.ts'
import { cleanupExpiredRecords, IDEMPOTENCY_GRACE_DAYS } from '@/modules/maintenance/cleanup.ts'
import { testPrisma } from '@/tests/helpers/setup-db.ts'

/**
 * 監査ログの参照と、期限切れレコードの掃除の統合テスト（Phase 8）。
 *
 * 確認する不変条件:
 *  - 監査ログは追記専用（UPDATE / DELETE が DB に拒否される）
 *  - 掃除が消すのはセッションと冪等性キーだけ
 *  - 冪等性キーは期限直後には消さない（遅れて届いた再送を守る）
 *  - 掃除は台帳・抽選・監査ログに触れない
 */

let userId: string

async function createUser(email: string): Promise<string> {
  const user = await testPrisma.user.create({
    data: {
      email,
      passwordHash: 'dummy-hash',
      profile: { create: { displayName: email } },
      pointAccount: { create: {} },
    },
    select: { id: true },
  })
  return user.id
}

beforeEach(async () => {
  userId = await createUser('maintenance-user@example.test')
})

/* -------------------------------------------------------------------------- */

describe('監査ログの参照', () => {
  it('書いたログを読み出せる', async () => {
    await writeAuditLog({
      actorType: 'ADMIN',
      actorId: userId,
      action: AUDIT_ACTIONS.ORIPA_SUSPEND,
      targetType: 'ORIPA_CAMPAIGN',
      targetId: 'campaign-1',
      reason: 'テスト',
    })

    const result = await listAuditLogs({
      page: 1,
      perPage: 50,
      targetId: 'campaign-1',
    })

    expect(result.total).toBe(1)
    expect(result.items[0]?.action).toBe('ORIPA_SUSPEND')
    expect(result.items[0]?.reason).toBe('テスト')
    // 実行者のメールアドレスは複写せず、参照時に引く
    expect(result.items[0]?.actorEmail).toBe('maintenance-user@example.test')
  })

  it('操作種別で絞り込める', async () => {
    await writeAuditLog({
      actorType: 'ADMIN',
      actorId: userId,
      action: AUDIT_ACTIONS.ORIPA_PUBLISH,
    })
    await writeAuditLog({
      actorType: 'ADMIN',
      actorId: userId,
      action: AUDIT_ACTIONS.ORIPA_SUSPEND,
    })

    const result = await listAuditLogs({
      page: 1,
      perPage: 50,
      action: AUDIT_ACTIONS.ORIPA_PUBLISH,
      actorId: userId,
    })

    expect(result.total).toBe(1)
    expect(result.items[0]?.action).toBe('ORIPA_PUBLISH')
  })

  it('実行者の種別で絞り込める', async () => {
    await writeAuditLog({
      actorType: 'ADMIN',
      actorId: userId,
      action: AUDIT_ACTIONS.ORIPA_PUBLISH,
    })
    await writeAuditLog({ actorType: 'SYSTEM', action: AUDIT_ACTIONS.POINT_EXPIRED })

    const admin = await listAuditLogs({
      page: 1,
      perPage: 50,
      actorType: 'ADMIN',
      actorId: userId,
    })
    const system = await listAuditLogs({ page: 1, perPage: 50, actorType: 'SYSTEM' })

    expect(admin.total).toBe(1)
    expect(system.total).toBeGreaterThanOrEqual(1)
    // システム操作には実行者がいない
    expect(system.items[0]?.actorId).toBeNull()
  })

  it('新しい順に並ぶ', async () => {
    await writeAuditLog({
      actorType: 'ADMIN',
      actorId: userId,
      action: AUDIT_ACTIONS.ORIPA_CREATE,
    })
    await writeAuditLog({
      actorType: 'ADMIN',
      actorId: userId,
      action: AUDIT_ACTIONS.ORIPA_PUBLISH,
    })

    const result = await listAuditLogs({ page: 1, perPage: 50, actorId: userId })

    expect(result.items[0]?.action).toBe('ORIPA_PUBLISH')
    expect(result.items[1]?.action).toBe('ORIPA_CREATE')
  })

  it('機微情報は書き込み時点で伏せ字になっている', async () => {
    await writeAuditLog({
      actorType: 'ADMIN',
      actorId: userId,
      action: AUDIT_ACTIONS.USER_SUSPEND,
      targetId: 'target-user',
      before: { email: 'x@example.test', passwordHash: 'should-not-appear' },
    })

    const result = await listAuditLogs({ page: 1, perPage: 50, targetId: 'target-user' })
    const before = result.items[0]?.before as Record<string, unknown>

    expect(before.passwordHash).not.toBe('should-not-appear')
    expect(JSON.stringify(before)).not.toContain('should-not-appear')
  })

  it('記録済みの操作種別だけを選択肢に出す', async () => {
    await writeAuditLog({
      actorType: 'ADMIN',
      actorId: userId,
      action: AUDIT_ACTIONS.ORIPA_PUBLISH,
    })

    const actions = await listRecordedActions()
    expect(actions).toContain('ORIPA_PUBLISH')
    // 一度も起きていない操作は並ばない
    expect(actions).not.toContain('ORIPA_SEED_REVEAL')
  })

  it('監査ログは書き換えられない（DB トリガ）', async () => {
    await writeAuditLog({
      actorType: 'ADMIN',
      actorId: userId,
      action: AUDIT_ACTIONS.ORIPA_PUBLISH,
      targetId: 'immutable-target',
    })

    const log = await testPrisma.auditLog.findFirstOrThrow({
      where: { targetId: 'immutable-target' },
      select: { id: true },
    })

    await expect(
      testPrisma.$executeRaw`UPDATE audit_logs SET reason = 'tampered' WHERE id = ${log.id}`,
    ).rejects.toThrow(/APPEND_ONLY_VIOLATION/)

    await expect(
      testPrisma.$executeRaw`DELETE FROM audit_logs WHERE id = ${log.id}`,
    ).rejects.toThrow(/APPEND_ONLY_VIOLATION/)
  })
})

/* -------------------------------------------------------------------------- */

describe('期限切れレコードの掃除', () => {
  async function createSession(expiresAt: Date): Promise<string> {
    const session = await testPrisma.userSession.create({
      data: { userId, expiresAt },
      select: { id: true },
    })
    return session.id
  }

  async function createIdempotencyKey(expiresAt: Date): Promise<string> {
    const key = await testPrisma.idempotencyKey.create({
      data: {
        userId,
        scope: 'test',
        key: `cleanup-${Math.random()}`,
        requestHash: 'test',
        state: 'SUCCEEDED',
        expiresAt,
      },
      select: { id: true },
    })
    return key.id
  }

  it('期限切れセッションを消し、有効なものは残す', async () => {
    const expired = await createSession(addDays(now(), -1))
    const valid = await createSession(addDays(now(), 30))

    const result = await cleanupExpiredRecords(testPrisma)

    expect(result.expiredSessions).toBeGreaterThanOrEqual(1)
    expect(await testPrisma.userSession.findUnique({ where: { id: expired } })).toBeNull()
    expect(await testPrisma.userSession.findUnique({ where: { id: valid } })).not.toBeNull()
  })

  it('期限切れ直後の冪等性キーは消さない（遅れて届いた再送を守る）', async () => {
    // 期限は切れているが、猶予の範囲内
    const recentlyExpired = await createIdempotencyKey(addDays(now(), -1))

    await cleanupExpiredRecords(testPrisma)

    expect(
      await testPrisma.idempotencyKey.findUnique({ where: { id: recentlyExpired } }),
    ).not.toBeNull()
  })

  it('猶予を過ぎた冪等性キーは消す', async () => {
    const longExpired = await createIdempotencyKey(
      addDays(now(), -(IDEMPOTENCY_GRACE_DAYS + 1)),
    )

    const result = await cleanupExpiredRecords(testPrisma)

    expect(result.expiredIdempotencyKeys).toBeGreaterThanOrEqual(1)
    expect(
      await testPrisma.idempotencyKey.findUnique({ where: { id: longExpired } }),
    ).toBeNull()
  })

  it('--dry-run 相当では数えるだけで消さない', async () => {
    const expired = await createSession(addDays(now(), -1))

    const result = await cleanupExpiredRecords(testPrisma, { dryRun: true })

    expect(result.expiredSessions).toBeGreaterThanOrEqual(1)
    expect(await testPrisma.userSession.findUnique({ where: { id: expired } })).not.toBeNull()
  })

  it('監査ログには触れない', async () => {
    await writeAuditLog({
      actorType: 'ADMIN',
      actorId: userId,
      action: AUDIT_ACTIONS.ORIPA_PUBLISH,
      targetId: 'survives-cleanup',
    })

    await cleanupExpiredRecords(testPrisma)

    const remaining = await testPrisma.auditLog.count({
      where: { targetId: 'survives-cleanup' },
    })
    expect(remaining).toBe(1)
  })
})
