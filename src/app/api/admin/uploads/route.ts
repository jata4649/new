import { errors } from '@/lib/api/errors.ts'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import {
  MAX_IMAGE_BYTES,
  maxImageMegabytes,
  validateImageUpload,
} from '@/lib/uploads/images.ts'
import { toUploadKey } from '@/lib/uploads/image-key.ts'
import { AUDIT_ACTIONS, writeAuditLog } from '@/modules/audit/service.ts'
import { saveUpload } from '@/server/uploads.ts'
import { withAuthedApi } from '@/lib/api/with-api.ts'
import { RATE_LIMIT_RULES } from '@/lib/rate-limit/index.ts'

/**
 * 景品画像のアップロード（管理者のみ）。
 *
 * ■ 受け取ったものを信用しない
 *   Content-Type もファイル名も利用者が自由に決められる。
 *   種類は先頭バイトで判定し、拡張子と保存名はサーバーが採番する。
 *   SVG は受け付けない（スクリプトを埋め込めるため）。
 *
 * ■ 容量制限は 2 段
 *   1. 読み込む前に Content-Length を見て、明らかに大きいものを弾く
 *   2. 読み込んだ実バイト数でもう一度確認する
 *   ヘッダだけを信じると、詐称された小さい Content-Length で
 *   大きな本体を送り込まれる。
 */
export const runtime = 'nodejs'

export const POST = withAuthedApi(
  {
    auth: 'admin',
    permission: PERMISSIONS.INVENTORY_WRITE,
    rateLimit: RATE_LIMIT_RULES.mutation,
  },
  async (ctx) => {
    // --- 1. 読み込む前の足切り ---
    const declaredLength = Number(ctx.req.headers.get('content-length') ?? '0')
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES * 2) {
      throw errors.validation([
        {
          field: 'file',
          message: `画像は ${maxImageMegabytes()} MB 以内にしてください`,
        },
      ])
    }

    const form = await ctx.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      throw errors.validation([{ field: 'file', message: '画像ファイルを選んでください' }])
    }

    const bytes = new Uint8Array(await file.arrayBuffer())

    // --- 2. 実バイト列での検証（種類・容量） ---
    const result = validateImageUpload(bytes)
    if (!result.ok) {
      const message =
        result.error.kind === 'TOO_LARGE'
          ? `画像は ${maxImageMegabytes()} MB 以内にしてください`
          : result.error.kind === 'EMPTY'
            ? '空のファイルはアップロードできません'
            : 'PNG / JPEG / WebP のみアップロードできます'
      throw errors.validation([{ field: 'file', message }])
    }

    await saveUpload(result.storedName, bytes)

    await writeAuditLog({
      actorType: 'ADMIN',
      actorId: ctx.session.id,
      action: AUDIT_ACTIONS.IMAGE_UPLOAD,
      targetId: result.storedName,
      after: {
        contentType: result.image.contentType,
        bytes: bytes.byteLength,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })

    return {
      imageKey: toUploadKey(result.storedName),
      contentType: result.image.contentType,
      bytes: bytes.byteLength,
    }
  },
)
