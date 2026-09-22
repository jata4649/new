import { Role } from '@/generated/prisma/enums.ts'

/**
 * RBAC の権限定義。
 *
 * 要件: 「管理画面には RBAC を実装する」「認可チェックを必ずサーバー側で行う」
 *
 * 設計:
 *  - ロールと権限の対応は「この 1 ファイルだけ」を真実とする。
 *    画面側の出し分けも同じテーブルを参照するため、表示と実権限がズレない。
 *  - 実際の判定は必ずサーバー側（withApi の permission オプション）で行う。
 *    UI での非表示は利便性のためであり、認可ではない。
 */

export const PERMISSIONS = {
  // ユーザー管理
  USER_READ: 'user:read',
  USER_UPDATE_STATUS: 'user:update_status',
  USER_ADJUST_POINTS: 'user:adjust_points',

  // 在庫管理
  INVENTORY_READ: 'inventory:read',
  INVENTORY_WRITE: 'inventory:write',

  // オリパ管理
  ORIPA_READ: 'oripa:read',
  ORIPA_WRITE: 'oripa:write',
  ORIPA_PUBLISH: 'oripa:publish',
  ORIPA_SUSPEND: 'oripa:suspend',

  // 抽選履歴
  DRAW_READ: 'draw:read',

  // 発送管理
  SHIPPING_READ: 'shipping:read',
  SHIPPING_UPDATE: 'shipping:update',

  // 監査・システム
  AUDIT_READ: 'audit:read',
  ADMIN_MANAGE_ROLES: 'admin:manage_roles',
  /** 開発用の Mock 決済操作（本番相当環境では誰にも与えない） */
  TEST_PAYMENT_OPERATE: 'test_payment:operate',
} as const

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

const SUPPORT_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.USER_READ,
  PERMISSIONS.INVENTORY_READ,
  PERMISSIONS.ORIPA_READ,
  PERMISSIONS.DRAW_READ,
  PERMISSIONS.SHIPPING_READ,
]

const OPERATOR_PERMISSIONS: readonly Permission[] = [
  ...SUPPORT_PERMISSIONS,
  PERMISSIONS.INVENTORY_WRITE,
  PERMISSIONS.ORIPA_WRITE,
  PERMISSIONS.SHIPPING_UPDATE,
]

const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...OPERATOR_PERMISSIONS,
  PERMISSIONS.ORIPA_PUBLISH,
  PERMISSIONS.ORIPA_SUSPEND,
  PERMISSIONS.USER_UPDATE_STATUS,
  PERMISSIONS.USER_ADJUST_POINTS,
  PERMISSIONS.AUDIT_READ,
  PERMISSIONS.TEST_PAYMENT_OPERATE,
]

const SUPER_ADMIN_PERMISSIONS: readonly Permission[] = [
  ...ADMIN_PERMISSIONS,
  PERMISSIONS.ADMIN_MANAGE_ROLES,
]

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  [Role.USER]: [],
  [Role.SUPPORT]: SUPPORT_PERMISSIONS,
  [Role.OPERATOR]: OPERATOR_PERMISSIONS,
  [Role.ADMIN]: ADMIN_PERMISSIONS,
  [Role.SUPER_ADMIN]: SUPER_ADMIN_PERMISSIONS,
}

/** 管理画面（/admin/*）へアクセスできるロール */
export const ADMIN_ROLES: readonly Role[] = [
  Role.SUPPORT,
  Role.OPERATOR,
  Role.ADMIN,
  Role.SUPER_ADMIN,
]

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission)
}

export function hasAnyPermission(role: Role, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => hasPermission(role, p))
}

export function isAdminRole(role: Role): boolean {
  return ADMIN_ROLES.includes(role)
}

/**
 * 「理由の入力」を必須とする危険操作。
 * withApi の audit.requireReason と合わせて使う。
 */
export const REASON_REQUIRED_ACTIONS: readonly string[] = [
  'USER_SUSPEND',
  'USER_WITHDRAW',
  'POINT_ADJUST',
  'ORIPA_SUSPEND',
  'SHIPPING_CANCEL',
  'INVENTORY_MARK_DAMAGED',
  'INVENTORY_MARK_LOST',
]
