import { describe, expect, it } from 'vitest'

import { Role } from '@/generated/prisma/enums.ts'
import {
  ADMIN_ROLES,
  hasAnyPermission,
  hasPermission,
  isAdminRole,
  PERMISSIONS,
  REASON_REQUIRED_ACTIONS,
  ROLE_PERMISSIONS,
} from '@/lib/auth/permissions.ts'

/**
 * RBAC の検証。
 *
 * 権限テーブルは画面の出し分けと API の認可の両方が参照する唯一の根拠なので、
 * 「一般ユーザーに管理権限が漏れていないか」を機械的に確認する。
 */

describe('ROLE_PERMISSIONS', () => {
  it('一般ユーザーは管理権限を一切持たない', () => {
    expect(ROLE_PERMISSIONS[Role.USER]).toEqual([])
  })

  it('権限は上位ロールへ向かって単調に増える', () => {
    const chain = [Role.USER, Role.SUPPORT, Role.OPERATOR, Role.ADMIN, Role.SUPER_ADMIN]

    for (let i = 1; i < chain.length; i++) {
      const lower = ROLE_PERMISSIONS[chain[i - 1]!]
      const higher = ROLE_PERMISSIONS[chain[i]!]

      for (const permission of lower) {
        expect(
          higher.includes(permission),
          `${chain[i]} が ${chain[i - 1]} の権限 ${permission} を失っています`,
        ).toBe(true)
      }
      expect(higher.length).toBeGreaterThan(lower.length)
    }
  })

  it('同じ権限を重複して持たない', () => {
    for (const role of Object.values(Role)) {
      const permissions = ROLE_PERMISSIONS[role]
      expect(new Set(permissions).size).toBe(permissions.length)
    }
  })
})

describe('hasPermission', () => {
  it('SUPPORT は参照のみで、書き込み権限を持たない', () => {
    expect(hasPermission(Role.SUPPORT, PERMISSIONS.USER_READ)).toBe(true)
    expect(hasPermission(Role.SUPPORT, PERMISSIONS.INVENTORY_READ)).toBe(true)
    expect(hasPermission(Role.SUPPORT, PERMISSIONS.INVENTORY_WRITE)).toBe(false)
    expect(hasPermission(Role.SUPPORT, PERMISSIONS.USER_UPDATE_STATUS)).toBe(false)
  })

  it('OPERATOR はオリパを作れるが公開はできない', () => {
    expect(hasPermission(Role.OPERATOR, PERMISSIONS.ORIPA_WRITE)).toBe(true)
    expect(hasPermission(Role.OPERATOR, PERMISSIONS.ORIPA_PUBLISH)).toBe(false)
    expect(hasPermission(Role.OPERATOR, PERMISSIONS.ORIPA_SUSPEND)).toBe(false)
  })

  it('ポイント調整と監査ログ参照は ADMIN 以上に限る', () => {
    for (const role of [Role.USER, Role.SUPPORT, Role.OPERATOR]) {
      expect(hasPermission(role, PERMISSIONS.USER_ADJUST_POINTS)).toBe(false)
      expect(hasPermission(role, PERMISSIONS.AUDIT_READ)).toBe(false)
    }
    expect(hasPermission(Role.ADMIN, PERMISSIONS.USER_ADJUST_POINTS)).toBe(true)
    expect(hasPermission(Role.ADMIN, PERMISSIONS.AUDIT_READ)).toBe(true)
  })

  it('ロール管理は SUPER_ADMIN だけが持つ', () => {
    expect(hasPermission(Role.ADMIN, PERMISSIONS.ADMIN_MANAGE_ROLES)).toBe(false)
    expect(hasPermission(Role.SUPER_ADMIN, PERMISSIONS.ADMIN_MANAGE_ROLES)).toBe(true)
  })

  it('テスト決済の操作権限は一般ユーザーに無い', () => {
    expect(hasPermission(Role.USER, PERMISSIONS.TEST_PAYMENT_OPERATE)).toBe(false)
  })
})

describe('hasAnyPermission', () => {
  it('いずれか 1 つでも持っていれば true', () => {
    expect(
      hasAnyPermission(Role.SUPPORT, [PERMISSIONS.ADMIN_MANAGE_ROLES, PERMISSIONS.USER_READ]),
    ).toBe(true)
  })

  it('1 つも持っていなければ false', () => {
    expect(hasAnyPermission(Role.USER, [PERMISSIONS.USER_READ, PERMISSIONS.ORIPA_READ])).toBe(
      false,
    )
  })

  it('空配列では false', () => {
    expect(hasAnyPermission(Role.SUPER_ADMIN, [])).toBe(false)
  })
})

describe('isAdminRole', () => {
  it('USER だけが管理画面へ入れない', () => {
    expect(isAdminRole(Role.USER)).toBe(false)
    for (const role of ADMIN_ROLES) {
      expect(isAdminRole(role)).toBe(true)
    }
  })
})

describe('REASON_REQUIRED_ACTIONS', () => {
  it('停止・ポイント調整・販売停止が含まれている', () => {
    expect(REASON_REQUIRED_ACTIONS).toContain('USER_SUSPEND')
    expect(REASON_REQUIRED_ACTIONS).toContain('POINT_ADJUST')
    expect(REASON_REQUIRED_ACTIONS).toContain('ORIPA_SUSPEND')
  })
})
