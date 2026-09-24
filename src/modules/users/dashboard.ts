import { CampaignStatus, UserStatus } from '@/generated/prisma/enums.ts'
import { now, startOfDayJst } from '@/lib/datetime/index.ts'
import { prisma } from '@/server/db.ts'

/**
 * 管理ダッシュボードの集計。
 *
 * 要件どおり MVP では簡易集計にとどめる。
 * 件数が増えたら集計テーブルまたはマテリアライズドビューへ置き換える。
 */

export interface DashboardStats {
  userCount: number
  suspendedUserCount: number
  activeCampaignCount: number
  totalDrawCount: number
  todayDrawCount: number
  issuedPoints: number
  consumedPoints: number
  pendingShippingCount: number
  availableInventoryCount: number
}

export interface RecentAuditLog {
  id: string
  actorId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  reason: string | null
  createdAt: Date
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const todayStart = startOfDayJst(now())

  const [
    userCount,
    suspendedUserCount,
    activeCampaignCount,
    totalDrawCount,
    todayDrawCount,
    pointSums,
    pendingShippingCount,
    availableInventoryCount,
  ] = await Promise.all([
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { deletedAt: null, status: UserStatus.SUSPENDED } }),
    prisma.oripaCampaign.count({
      where: { status: CampaignStatus.ACTIVE, deletedAt: null },
    }),
    prisma.drawTransaction.count(),
    prisma.drawTransaction.count({ where: { createdAt: { gte: todayStart } } }),
    // 発行（正）と消費（負）を 1 クエリで集計する
    prisma.$queryRaw<{ issued: bigint | null; consumed: bigint | null }[]>`
      SELECT
        SUM(amount) FILTER (WHERE amount > 0) AS issued,
        SUM(-amount) FILTER (WHERE amount < 0) AS consumed
      FROM point_ledger_entries
    `,
    prisma.shippingRequest.count({
      where: { status: { in: ['REQUESTED', 'CHECKING', 'PACKING'] } },
    }),
    prisma.inventory.count({ where: { status: 'AVAILABLE', deletedAt: null } }),
  ])

  const sums = pointSums[0]

  return {
    userCount,
    suspendedUserCount,
    activeCampaignCount,
    totalDrawCount,
    todayDrawCount,
    issuedPoints: Number(sums?.issued ?? 0),
    consumedPoints: Number(sums?.consumed ?? 0),
    pendingShippingCount,
    availableInventoryCount,
  }
}

export async function getRecentAuditLogs(limit = 10): Promise<RecentAuditLog[]> {
  return prisma.auditLog.findMany({
    select: {
      id: true,
      actorId: true,
      action: true,
      targetType: true,
      targetId: true,
      reason: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}
