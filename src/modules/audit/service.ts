import { type Prisma } from '@/generated/prisma/client.ts'
import type { AuditActorType } from '@/generated/prisma/enums.ts'
import { redact } from '@/lib/observability/index.ts'
import { prisma, type PrismaTransactionClient } from '@/server/db.ts'

/**
 * 監査ログ。
 *
 * 要件: 「管理者操作を audit_logs へ記録する」
 *
 * 原則:
 *  - **業務処理と同じトランザクションで書く。** 別トランザクションにすると
 *    「操作は成功したのに記録が無い」状態が生まれ、監査の意味が無くなる。
 *  - before / after は必ず redact() を通す。
 *    パスワードハッシュ・トークンがログに残ると、監査ログ自体が攻撃対象になる。
 *  - audit_logs は追記専用（DB トリガで UPDATE / DELETE を拒否）。
 */

/** 監査対象となる操作の種別。文字列直書きを避けて一覧性を保つ。 */
export const AUDIT_ACTIONS = {
  // 認証・ユーザー
  USER_SIGNUP: 'USER_SIGNUP',
  USER_LOGIN: 'USER_LOGIN',
  USER_LOGIN_FAILED: 'USER_LOGIN_FAILED',
  USER_LOGOUT: 'USER_LOGOUT',
  USER_SESSIONS_REVOKED: 'USER_SESSIONS_REVOKED',
  USER_SUSPEND: 'USER_SUSPEND',
  USER_REACTIVATE: 'USER_REACTIVATE',
  USER_WITHDRAW: 'USER_WITHDRAW',

  // ポイント（Phase 3）
  POINT_ADJUST: 'POINT_ADJUST',

  // オリパ（Phase 4-5）
  ORIPA_CREATE: 'ORIPA_CREATE',
  ORIPA_UPDATE: 'ORIPA_UPDATE',
  ORIPA_PUBLISH: 'ORIPA_PUBLISH',
  ORIPA_SUSPEND: 'ORIPA_SUSPEND',
  DRAW_EXECUTED: 'DRAW_EXECUTED',

  // 在庫・発送（Phase 4, 7）
  INVENTORY_CREATE: 'INVENTORY_CREATE',
  INVENTORY_UPDATE: 'INVENTORY_UPDATE',
  SHIPPING_STATUS_UPDATE: 'SHIPPING_STATUS_UPDATE',
  SHIPPING_CANCEL: 'SHIPPING_CANCEL',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]

/** 監査対象のエンティティ種別 */
export const AUDIT_TARGETS = {
  USER: 'USER',
  ORIPA_CAMPAIGN: 'ORIPA_CAMPAIGN',
  INVENTORY: 'INVENTORY',
  SHIPPING_REQUEST: 'SHIPPING_REQUEST',
  POINT_ACCOUNT: 'POINT_ACCOUNT',
} as const

export type AuditTarget = (typeof AUDIT_TARGETS)[keyof typeof AUDIT_TARGETS]

export interface AuditEntry {
  actorType: AuditActorType
  /** システム操作では null */
  actorId?: string | null
  action: AuditAction
  targetType?: AuditTarget | null
  targetId?: string | null
  /** 危険操作では必須。呼び出し側で検証する。 */
  reason?: string | null
  before?: unknown
  after?: unknown
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

/**
 * 監査ログの before / after へ入れる値を整える。
 *
 * Prisma の Json 型では「SQL の NULL」を Prisma.DbNull で表す必要があるため、
 * 未指定は undefined（＝カラムを触らない）として扱い、DB 側の既定 NULL に任せる。
 */
function toJsonOrUndefined(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined
  const redacted = redact(value)
  return typeof redacted === 'object' && redacted !== null
    ? (redacted as Prisma.InputJsonValue)
    : { value: redacted as Prisma.InputJsonValue }
}

/**
 * 監査ログを 1 件書く。
 *
 * tx を渡すことで業務処理と同一トランザクションに載る。
 * 省略した場合はトランザクション外で書くため、
 * 「記録だけ残って処理は失敗した」ことが起こりうる。
 * ログイン失敗の記録など、業務トランザクションが存在しない場合にのみ省略すること。
 */
export async function writeAuditLog(
  entry: AuditEntry,
  tx: PrismaTransactionClient = prisma,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      reason: entry.reason ?? null,
      before: toJsonOrUndefined(entry.before),
      after: toJsonOrUndefined(entry.after),
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      requestId: entry.requestId ?? null,
    },
  })
}
