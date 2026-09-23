import { secureToken } from '@/lib/crypto/random.ts'

/**
 * 画像アップロードの検証。
 *
 * 要件: 「カード画像等のアップロード形式と容量を制限する」
 *
 * ■ Content-Type を信用しない
 *   ブラウザが送る Content-Type は利用者が自由に詐称できる。
 *   実体が PHP スクリプトでも `image/png` と名乗れてしまう。
 *   先頭バイト（マジックナンバー）を見て、種類は自分で判定する。
 *
 * ■ 拡張子も利用者から受け取らない
 *   判定した種類から拡張子を決める。受け取った名前を使うと
 *   `../../etc/passwd` や `x.png.php` のような値を持ち込まれる。
 *
 * ■ 保存名も利用者から受け取らない
 *   乱数で採番する。元のファイル名は保存にも配信にも使わない。
 *   元の名前には利用者の個人情報が入っていることもある。
 *
 * ■ SVG は受け付けない
 *   SVG は XML であり、スクリプトを埋め込める。
 *   画像として配信すると保存型 XSS になる。
 *   プレースホルダー SVG はサーバーが生成するものだけを使う。
 */

/** 1 ファイルあたりの上限。カード画像として十分で、悪用の余地を抑える大きさ。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** 許可する形式。ここに無いものは一切受け付けない。 */
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number]

export interface DetectedImage {
  contentType: AllowedImageType
  extension: 'png' | 'jpg' | 'webp'
}

export type ImageValidationError =
  | { kind: 'EMPTY' }
  | { kind: 'TOO_LARGE'; maxBytes: number; actualBytes: number }
  | { kind: 'UNSUPPORTED_TYPE' }

export type ImageValidationResult =
  | { ok: true; image: DetectedImage; storedName: string }
  | { ok: false; error: ImageValidationError }

/** PNG: 89 50 4E 47 0D 0A 1A 0A */
function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return signature.every((byte, index) => bytes[index] === byte)
}

/** JPEG: FF D8 FF で始まり、FF D9 で終わる */
function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

/** WebP: "RIFF" ....  "WEBP" */
function isWebp(bytes: Uint8Array): boolean {
  const riff = [0x52, 0x49, 0x46, 0x46]
  const webp = [0x57, 0x45, 0x42, 0x50]
  return (
    riff.every((byte, index) => bytes[index] === byte) &&
    webp.every((byte, index) => bytes[8 + index] === byte)
  )
}

/**
 * 先頭バイトから画像の種類を判定する。
 * 判定できなければ null（＝受け付けない）。
 */
export function detectImageType(bytes: Uint8Array): DetectedImage | null {
  if (isPng(bytes)) return { contentType: 'image/png', extension: 'png' }
  if (isJpeg(bytes)) return { contentType: 'image/jpeg', extension: 'jpg' }
  if (isWebp(bytes)) return { contentType: 'image/webp', extension: 'webp' }
  return null
}

/**
 * アップロードされたバイト列を検証し、保存名を決める。
 *
 * 元のファイル名は受け取らない。呼び出し側が渡してきても使わない。
 */
export function validateImageUpload(bytes: Uint8Array): ImageValidationResult {
  if (bytes.byteLength === 0) {
    return { ok: false, error: { kind: 'EMPTY' } }
  }

  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: {
        kind: 'TOO_LARGE',
        maxBytes: MAX_IMAGE_BYTES,
        actualBytes: bytes.byteLength,
      },
    }
  }

  const image = detectImageType(bytes)
  if (!image) {
    return { ok: false, error: { kind: 'UNSUPPORTED_TYPE' } }
  }

  return {
    ok: true,
    image,
    // 保存名は乱数。元のファイル名は保存にも配信にも使わない。
    storedName: `${secureToken(16)}.${image.extension}`,
  }
}

/** 上限をメガバイト表記にする（画面の案内用） */
export function maxImageMegabytes(): number {
  return MAX_IMAGE_BYTES / (1024 * 1024)
}
