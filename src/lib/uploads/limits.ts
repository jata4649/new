/**
 * アップロードの制限値。
 *
 * ■ なぜ検証本体から切り離すのか
 *   `images.ts` はバイト列の判定と保存名の採番を行い、
 *   採番に `node:crypto` を使う。クライアントコンポーネントから
 *   制限値を読むためにそのファイルを import すると、
 *   ブラウザ側のバンドルへ node 専用モジュールが引き込まれてしまう。
 *
 *   制限値は「画面にも出したい」情報なので、
 *   node に依存しない側へ置いて両方から参照する。
 */

/** 1 ファイルあたりの上限。カード画像として十分で、悪用の余地を抑える大きさ。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** 許可する形式。ここに無いものは一切受け付けない。 */
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number]

/** 上限をメガバイト表記にする（画面の案内用） */
export function maxImageMegabytes(): number {
  return MAX_IMAGE_BYTES / (1024 * 1024)
}
