import type { AuditActorType, Prisma } from '@/generated/prisma/client.ts'
import { prisma } from '@/server/db.ts'

import type { AuditLogListQuery } from './schema.ts'

/**
 * 監査ログの参照。
 *
 * ■ 参照しか無い
 *   書き込みは `service.ts` の writeAuditLog だけ。
 *   更新・削除の関数はここにも service にも存在せず、
 *   DB トリガ（`audit_logs_append_only_trigger`）が UPDATE / DELETE を拒否する。
 *
 * ■ before / after はそのまま返す
 *   書き込み時に redact() を通しているので、
 *   パスワードハッシュやトークンはこの時点で既に伏せ字になっている。
 *   読み出し側で伏せ直すと「いつ伏せられたのか」が曖昧になるため、
 *   伏せるのは書き込みの 1 か所に集約する。
 */

export interface AuditLogItem {
  id: string
  actorType: AuditActorType
  actorId: string | null
  /** 実行者のメールアドレス。すでに退会・削除されていれば null */
  actorEmail: string | null
  action: string
  targetType: string | null
  targetId: string | null
  reason: string | null
  before: unknown
  after: unknown
  ip: string | null
  requestId: string | null
  createdAt: Date
}

export interface AuditLogListResult {
  items: AuditLogItem[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

/** JST の日付文字列（YYYY-MM-DD）を、その日の 00:00 JST に対応する Date にする */
function startOfJstDay(date: string): Date {
  return new Date(`${date}T00:00:00+09:00`)
}

/** 同じく、翌日の 00:00 JST（`lt` で使うので終端は含めない） */
function startOfNextJstDay(date: string): Date {
  const start = startOfJstDay(date)
  return new Date(start.getTime() + 24 * 60 * 60 * 1000)
}

export async function listAuditLogs(query: AuditLogListQuery): Promise<AuditLogListResult> {
  const createdAt: Prisma.DateTimeFilter = {}
  if (query.from) createdAt.gte = startOfJstDay(query.from)
  if (query.to) createdAt.lt = startOfNextJstDay(query.to)

  const where: Prisma.AuditLogWhereInput = {
    ...(query.action ? { action: query.action } : {}),
    ...(query.actorType ? { actorType: query.actorType } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.targetType ? { targetType: query.targetType } : {}),
    ...(query.targetId ? { targetId: query.targetId } : {}),
    ...(query.from || query.to ? { createdAt } : {}),
  }

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      // 新しい順。問い合わせは「直近に何が起きたか」から入る。
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
      select: {
        id: true,
        actorType: true,
        actorId: true,
        action: true,
        targetType: true,
        targetId: true,
        reason: true,
        before: true,
        after: true,
        ip: true,
        requestId: true,
        createdAt: true,
      },
    }),
  ])

  /*
   * 実行者のメールアドレスを引く。
   *
   * audit_logs に複写しないのは、メールアドレスが変わったときに
   * 「過去のログのメールアドレスだけ古い」状態を作らないため。
   * 誰が実行したかの正は actor_id（変わらない）。
   * 表示のための名前は、見るたびに現在の値を引く。
   */
  const actorIds = [
    ...new Set(rows.map((row) => row.actorId).filter((id): id is string => !!id)),
  ]
  const actors =
    actorIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, email: true },
        })
      : []
  const emailById = new Map(actors.map((actor) => [actor.id, actor.email]))

  return {
    items: rows.map((row) => ({
      ...row,
      actorEmail: row.actorId ? (emailById.get(row.actorId) ?? null) : null,
    })),
    total,
    page: query.page,
    perPage: query.perPage,
    totalPages: Math.max(1, Math.ceil(total / query.perPage)),
  }
}

/**
 * 画面の絞り込みに出す操作種別の一覧。
 *
 * 定数（AUDIT_ACTIONS）ではなく実際に記録されている値から作る。
 * 定数から作ると「一度も起きていない操作」まで選択肢に並び、
 * 選んでも 0 件になって迷わせる。
 */
export async function listRecordedActions(): Promise<string[]> {
  const rows = await prisma.auditLog.groupBy({
    by: ['action'],
    orderBy: { action: 'asc' },
  })
  return rows.map((row) => row.action)
}
