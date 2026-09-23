import { z } from 'zod'

import { AuditActorType } from '@/generated/prisma/enums.ts'

/**
 * 監査ログの検索条件。
 *
 * ■ 参照専用であることを入力の形でも示す
 *   作成・更新・削除のスキーマは作らない。
 *   audit_logs は追記専用で、DB トリガが UPDATE / DELETE を拒否する。
 *   「書き込む入力が存在しない」ことが、画面から改ざんできない根拠になる。
 *
 * ■ 期間で絞れるようにする
 *   問い合わせ対応は「いつの操作か」から入ることが多い。
 *   件数が増えるほど、日付で絞れないと実用にならない。
 */

export const auditLogListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(50),
    /** 'ORIPA_PUBLISH' などの操作種別 */
    action: z.string().trim().max(64).optional(),
    actorType: z.enum(AuditActorType).optional(),
    /** 実行者の ID。メールアドレスではなく ID で絞る（ログに残るのが ID のため） */
    actorId: z.string().trim().max(64).optional(),
    targetType: z.string().trim().max(64).optional(),
    targetId: z.string().trim().max(64).optional(),
    /** JST の日付（YYYY-MM-DD）。指定日の 00:00 以降 */
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD で指定してください')
      .optional(),
    /** JST の日付（YYYY-MM-DD）。指定日の 23:59:59 まで */
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD で指定してください')
      .optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: '開始日は終了日より前にしてください',
    path: ['from'],
  })

export type AuditLogListQuery = z.infer<typeof auditLogListQuerySchema>
