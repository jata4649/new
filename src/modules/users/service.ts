import type { Role, UserStatus as UserStatusType } from '@/generated/prisma/enums.ts'
import { UserStatus } from '@/generated/prisma/enums.ts'
import { errors } from '@/lib/api/errors.ts'
import { now } from '@/lib/datetime/index.ts'
import { AUDIT_ACTIONS, AUDIT_TARGETS, writeAuditLog } from '@/modules/audit/service.ts'
import { revokeAllSessions, type RequestContext } from '@/modules/auth/service.ts'
import { prisma, TRANSACTION_OPTIONS } from '@/server/db.ts'

import type { UpdateUserStatusInput, UserListQuery } from './schema.ts'

/**
 * ユーザー管理（管理画面用）。
 *
 * 認可の判定は withApi が済ませている前提。ここでは業務ルールだけを扱う。
 * パスワードハッシュは**どの経路でも返さない**（select で明示的に除外する）。
 */

export interface UserListItem {
  id: string
  email: string
  displayName: string | null
  role: Role
  status: UserStatusType
  paidBalance: number
  freeBalance: number
  lastLoginAt: Date | null
  createdAt: Date
}

export interface UserListResult {
  items: UserListItem[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export async function listUsers(query: UserListQuery): Promise<UserListResult> {
  const where = {
    deletedAt: null,
    ...(query.status ? { status: query.status } : {}),
    ...(query.q
      ? {
          OR: [
            { email: { contains: query.q, mode: 'insensitive' as const } },
            {
              profile: {
                displayName: { contains: query.q, mode: 'insensitive' as const },
              },
            },
          ],
        }
      : {}),
  }

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        lastLoginAt: true,
        createdAt: true,
        profile: { select: { displayName: true } },
        pointAccount: { select: { paidBalance: true, freeBalance: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    }),
  ])

  return {
    items: users.map((user) => ({
      id: user.id,
      email: user.email,
      displayName: user.profile?.displayName ?? null,
      role: user.role,
      status: user.status,
      paidBalance: user.pointAccount?.paidBalance ?? 0,
      freeBalance: user.pointAccount?.freeBalance ?? 0,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    })),
    total,
    page: query.page,
    perPage: query.perPage,
    totalPages: Math.max(1, Math.ceil(total / query.perPage)),
  }
}

export interface UserDetail extends UserListItem {
  emailVerified: Date | null
  statusReason: string | null
  statusChangedAt: Date | null
  activeSessionCount: number
  /** Phase 3 以降で件数が入る */
  drawCount: number
  prizeCount: number
  shippingRequestCount: number
}

export async function getUserDetail(userId: string): Promise<UserDetail> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      email: true,
      emailVerified: true,
      role: true,
      status: true,
      statusReason: true,
      statusChangedAt: true,
      lastLoginAt: true,
      createdAt: true,
      profile: { select: { displayName: true } },
      pointAccount: { select: { paidBalance: true, freeBalance: true } },
      _count: {
        select: {
          drawTransactions: true,
          prizes: true,
          shippingRequests: true,
        },
      },
    },
  })

  if (!user) {
    throw errors.notFound('ユーザー')
  }

  const activeSessionCount = await prisma.userSession.count({
    where: { userId, revokedAt: null, expiresAt: { gt: now() } },
  })

  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    displayName: user.profile?.displayName ?? null,
    role: user.role,
    status: user.status,
    statusReason: user.statusReason,
    statusChangedAt: user.statusChangedAt,
    paidBalance: user.pointAccount?.paidBalance ?? 0,
    freeBalance: user.pointAccount?.freeBalance ?? 0,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    activeSessionCount,
    drawCount: user._count.drawTransactions,
    prizeCount: user._count.prizes,
    shippingRequestCount: user._count.shippingRequests,
  }
}

/**
 * ユーザーのステータスを変更する。
 *
 * - 理由の入力は必須（Zod スキーマで保証済み）
 * - ACTIVE 以外へ変更した場合、**その場で全セッションを失効させる**。
 *   これをしないと、停止してもログイン中の端末は動き続けてしまう。
 * - 監査ログへ変更前後を記録する
 */
export async function updateUserStatus(
  userId: string,
  input: UpdateUserStatusInput,
  actor: { id: string; role: Role },
  context: RequestContext = {},
): Promise<{ id: string; status: UserStatusType }> {
  const target = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, status: true, role: true, email: true },
  })

  if (!target) {
    throw errors.notFound('ユーザー')
  }

  if (target.id === actor.id) {
    // 自分自身を停止すると管理画面から締め出される事故につながる
    throw errors.conflict('自分自身のステータスは変更できません', {
      actorId: actor.id,
    })
  }

  if (target.status === input.status) {
    throw errors.conflict('すでにそのステータスです', {
      userId,
      status: input.status,
    })
  }

  const changedAt = now()

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.user.update({
      where: { id: userId },
      data: {
        status: input.status,
        statusReason: input.reason,
        statusChangedAt: changedAt,
        ...(input.status === UserStatus.WITHDRAWN ? { deletedAt: changedAt } : {}),
      },
      select: { id: true, status: true },
    })

    await writeAuditLog(
      {
        actorType: 'ADMIN',
        actorId: actor.id,
        action:
          input.status === UserStatus.ACTIVE
            ? AUDIT_ACTIONS.USER_REACTIVATE
            : input.status === UserStatus.WITHDRAWN
              ? AUDIT_ACTIONS.USER_WITHDRAW
              : AUDIT_ACTIONS.USER_SUSPEND,
        targetType: AUDIT_TARGETS.USER,
        targetId: userId,
        reason: input.reason,
        before: { status: target.status },
        after: { status: input.status },
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      },
      tx,
    )

    return result
  }, TRANSACTION_OPTIONS)

  // ACTIVE 以外になったら、ログイン中の端末も即座に締め出す
  if (input.status !== UserStatus.ACTIVE) {
    await revokeAllSessions(userId, `管理者によるステータス変更: ${input.reason}`, {
      actorId: actor.id,
      actorType: 'ADMIN',
      ...context,
    })
  }

  return updated
}
