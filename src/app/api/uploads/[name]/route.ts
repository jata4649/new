import { NextResponse } from 'next/server'

import { detectImageType } from '@/lib/uploads/images.ts'
import { readUpload } from '@/server/uploads.ts'

/**
 * アップロード画像の配信。
 *
 * ■ Content-Type は保存時ではなく配信時にも判定する
 *   保存されたバイト列の先頭を見て決める。
 *   拡張子から決めると、拡張子だけ付け替えられたファイルを
 *   意図しない種類として配信してしまう。
 *
 * ■ ブラウザに種類を推測させない
 *   X-Content-Type-Options: nosniff を必ず付ける。
 *   Content-Disposition: inline でファイル名は渡さない
 *   （保存名は採番した値だが、渡さないほうが面が狭い）。
 *
 * ■ 存在しない場合と読めない場合を区別しない
 *   どちらも 404。区別するとファイルの有無を推測されうる。
 */
export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  segment: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const { name } = await segment.params

  const bytes = await readUpload(decodeURIComponent(name))
  if (!bytes) {
    return new NextResponse('見つかりません', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  // 保存済みのバイト列からもう一度種類を判定する
  const detected = detectImageType(new Uint8Array(bytes))
  if (!detected) {
    return new NextResponse('見つかりません', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': detected.contentType,
      'Content-Length': String(bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      // アップロード画像は差し替えのたびに保存名が変わるため、長期キャッシュしてよい
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
