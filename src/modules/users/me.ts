import type { Role, UserStatus } from '@/generated/prisma/enums.ts'
import { errors } from '@/lib/api/errors.ts'
import { prisma } from '@/server/db.ts'

/**
 * ログイン中ユーザー自身の情報。
 *
 * 管理画面用の users/service.ts と分けている理由:
 *  - 返してよい項目が違う（自分向けには仕入原価や他人の情報を出さない）
 *  - 取り違えによる情報漏れを、ファイル単位で防ぐ
 *
 * パスワードハッシュは select に含めない。
 */

export interface MyProfile {
  id: string
  email: string
  displayName: string | null
  role: Role
  status: UserStatus
  emailVerified: boolean
  points: {
    paid: number
    free: number
    total: number
  }
  createdAt: Date
}

export async function getMyProfile(userId: string): Promise<MyProfile> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      emailVerified: true,
      createdAt: true,
      profile: { select: { displayName: true } },
      pointAccount: { select: { paidBalance: true, freeBalance: true } },
    },
  })

  if (!user) {
    throw errors.notFound('ユーザー')
  }

  const paid = user.pointAccount?.paidBalance ?? 0
  const free = user.pointAccount?.freeBalance ?? 0

  return {
    id: user.id,
    email: user.email,
    displayName: user.profile?.displayName ?? null,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerified !== null,
    points: { paid, free, total: paid + free },
    createdAt: user.createdAt,
  }
}
