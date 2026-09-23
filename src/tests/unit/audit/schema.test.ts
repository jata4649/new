import { describe, expect, it } from 'vitest'

import { auditLogListQuerySchema } from '@/modules/audit/schema.ts'

/**
 * 監査ログの検索条件の単体テスト。
 *
 * 書き込み系のスキーマが存在しないことがこのモジュールの肝なので、
 * ここで検証するのは「読むための入力」だけになる。
 */

describe('auditLogListQuerySchema', () => {
  it('何も指定しなければ既定値で通る', () => {
    const parsed = auditLogListQuerySchema.parse({})
    expect(parsed.page).toBe(1)
    expect(parsed.perPage).toBe(50)
    expect(parsed.action).toBeUndefined()
  })

  it('日付は YYYY-MM-DD だけを受け付ける', () => {
    expect(auditLogListQuerySchema.safeParse({ from: '2026-09-23' }).success).toBe(true)
    expect(auditLogListQuerySchema.safeParse({ from: '2026/09/23' }).success).toBe(false)
    expect(auditLogListQuerySchema.safeParse({ from: '26-09-23' }).success).toBe(false)
    expect(auditLogListQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false)
  })

  it('開始日が終了日より後なら拒否する', () => {
    expect(
      auditLogListQuerySchema.safeParse({ from: '2026-09-24', to: '2026-09-23' }).success,
    ).toBe(false)
  })

  it('開始日と終了日が同じ日なら通る（その 1 日を見る指定）', () => {
    expect(
      auditLogListQuerySchema.safeParse({ from: '2026-09-23', to: '2026-09-23' }).success,
    ).toBe(true)
  })

  it('片方だけの指定も通る', () => {
    expect(auditLogListQuerySchema.safeParse({ from: '2026-09-23' }).success).toBe(true)
    expect(auditLogListQuerySchema.safeParse({ to: '2026-09-23' }).success).toBe(true)
  })

  it('実行者の種別は列挙のみ', () => {
    expect(auditLogListQuerySchema.safeParse({ actorType: 'ADMIN' }).success).toBe(true)
    expect(auditLogListQuerySchema.safeParse({ actorType: 'SYSTEM' }).success).toBe(true)
    expect(auditLogListQuerySchema.safeParse({ actorType: 'ROOT' }).success).toBe(false)
  })

  it('1 ページあたりの件数には上限がある（全件取得させない）', () => {
    expect(auditLogListQuerySchema.safeParse({ perPage: 100 }).success).toBe(true)
    expect(auditLogListQuerySchema.safeParse({ perPage: 101 }).success).toBe(false)
    expect(auditLogListQuerySchema.safeParse({ perPage: 0 }).success).toBe(false)
  })
})
