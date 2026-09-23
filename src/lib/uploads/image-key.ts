/**
 * 画像キーから配信 URL を決める。
 *
 * 画像キーには 2 種類ある。
 *   placeholder:<rarity>:<hue>:<face>  … サーバーが SVG を生成する（架空の見本）
 *   upload:<保存名>                     … 管理者がアップロードした実ファイル
 *
 * 呼び出し側がこの分岐を各自で書くと、新しい種類を足したときに
 * 直し漏れた画面だけ壊れる。判定はここ 1 か所に集約する。
 *
 * 【重要】保存名は必ずサーバーが採番したものであり、
 *   利用者が入力した文字列をそのままパスへ載せることはない。
 *   配信側（/api/uploads/[name]）でも形式を再検査している。
 */

const PLACEHOLDER_PREFIX = 'placeholder:'
const UPLOAD_PREFIX = 'upload:'

/** アップロード画像の保存名として許す形（採番の形と一致させる） */
export const UPLOAD_NAME_PATTERN = /^[A-Za-z0-9_-]{16,64}\.(png|jpg|webp)$/

export function imageSrc(imageKey: string): string {
  if (imageKey.startsWith(UPLOAD_PREFIX)) {
    return `/api/uploads/${encodeURIComponent(imageKey.slice(UPLOAD_PREFIX.length))}`
  }
  // 既定はプレースホルダー。未知の形式でも生成側が弾くので安全側に倒れる。
  return `/api/placeholder/${encodeURIComponent(imageKey)}`
}

export function isUploadKey(imageKey: string): boolean {
  return imageKey.startsWith(UPLOAD_PREFIX)
}

export function isPlaceholderKey(imageKey: string): boolean {
  return imageKey.startsWith(PLACEHOLDER_PREFIX)
}

/** 保存名から画像キーを作る（アップロード API の応答で使う） */
export function toUploadKey(storedName: string): string {
  return `${UPLOAD_PREFIX}${storedName}`
}
