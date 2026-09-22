/**
 * プレースホルダー画像（SVG）を生成して返す。
 *
 * 要件: 「実在キャラクターの画像や公式ロゴは使用しない」
 *       「カード画像は単色または架空カードのプレースホルダーにする」
 *
 * 画像ファイルをリポジトリへ持たず、画像キーから決定的に SVG を生成する。
 * これにより
 *   - 実在素材が紛れ込む余地が無い
 *   - 在庫を 100 件以上作ってもリポジトリが太らない
 * という 2 点を同時に満たす。
 *
 * 画像キーの形式: placeholder:<rarity>:<hue>:<front|back>
 */

export const runtime = 'nodejs'

const MAX_HUE = 359

interface ParsedKey {
  rarity: string
  hue: number
  face: 'front' | 'back'
}

function parseKey(raw: string): ParsedKey | null {
  const decoded = decodeURIComponent(raw)
  const parts = decoded.split(':')
  if (parts.length !== 4 || parts[0] !== 'placeholder') {
    return null
  }

  const [, rarity, hueText, face] = parts
  if (!rarity || !hueText || (face !== 'front' && face !== 'back')) {
    return null
  }

  // 入力はそのまま SVG へ埋め込まれるため、値域を厳密に絞る（XSS 対策）
  if (!/^[A-Z]{1,4}$/.test(rarity)) {
    return null
  }
  const hue = Number.parseInt(hueText, 10)
  if (!Number.isInteger(hue) || hue < 0 || hue > MAX_HUE) {
    return null
  }

  return { rarity, hue, face }
}

function renderSvg({ rarity, hue, face }: ParsedKey): string {
  const base = `hsl(${hue} 55% 22%)`
  const accent = `hsl(${(hue + 40) % 360} 70% 55%)`
  const edge = `hsl(${(hue + 200) % 360} 60% 45%)`

  if (face === 'back') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="672" viewBox="0 0 480 672" role="img" aria-label="カード裏面のプレースホルダー">
  <rect width="480" height="672" rx="28" fill="${base}"/>
  <rect x="18" y="18" width="444" height="636" rx="18" fill="none" stroke="${edge}" stroke-width="6"/>
  <circle cx="240" cy="336" r="118" fill="none" stroke="${accent}" stroke-width="10" opacity="0.7"/>
  <circle cx="240" cy="336" r="72" fill="none" stroke="${accent}" stroke-width="6" opacity="0.5"/>
  <text x="240" y="348" text-anchor="middle" font-family="sans-serif" font-size="30" fill="${accent}" opacity="0.85">SAMPLE</text>
</svg>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="672" viewBox="0 0 480 672" role="img" aria-label="カード表面のプレースホルダー">
  <rect width="480" height="672" rx="28" fill="${base}"/>
  <rect x="18" y="18" width="444" height="636" rx="18" fill="none" stroke="${edge}" stroke-width="6"/>
  <rect x="44" y="92" width="392" height="330" rx="12" fill="${accent}" opacity="0.28"/>
  <rect x="44" y="452" width="392" height="120" rx="12" fill="${edge}" opacity="0.22"/>
  <text x="44" y="70" font-family="sans-serif" font-size="30" font-weight="bold" fill="${accent}">${rarity}</text>
  <text x="240" y="268" text-anchor="middle" font-family="sans-serif" font-size="26" fill="hsl(${hue} 20% 88%)" opacity="0.8">架空カード</text>
  <text x="240" y="308" text-anchor="middle" font-family="sans-serif" font-size="20" fill="hsl(${hue} 20% 88%)" opacity="0.6">PLACEHOLDER</text>
  <text x="240" y="620" text-anchor="middle" font-family="sans-serif" font-size="18" fill="hsl(${hue} 20% 88%)" opacity="0.5">開発用サンプル画像</text>
</svg>`
}

export async function GET(
  _req: Request,
  segment: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await segment.params
  const parsed = parseKey(key)

  if (!parsed) {
    return new Response('Not Found', { status: 404 })
  }

  return new Response(renderSvg(parsed), {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // 決定的な生成結果なので長期キャッシュしてよい
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  })
}
