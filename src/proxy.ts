import { NextResponse, type NextRequest } from 'next/server'

/**
 * Proxy（Next.js 16 で middleware から名称変更された、リクエスト前段のフック）。
 *
 * 【ここで行うこと】粗いゲートだけ
 *   1. クローズドテスト中のサイト全体 Basic 認証（一般公開の事故防止）
 *   2. 管理画面の IP 制限（任意）
 *
 * 【ここで行わないこと】
 *   認証・認可の本判定。Edge ランタイムでは DB を引けないため、
 *   ユーザーの停止状態やロールを正しく確認できない。
 *   本判定は必ず Node ランタイム側（withApi / Server Component）で行う。
 *   ミドルウェアはあくまで「素早く弾く」ための層であり、
 *   ここを通過したことを認可の根拠にしてはならない。
 */

const BASIC_AUTH_REALM = 'Closed Test'

function unauthorizedBasic(): NextResponse {
  return new NextResponse('認証が必要です', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${BASIC_AUTH_REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}

/**
 * 一定時間比較。Edge ランタイムでは node:crypto が使えないため自前で実装する。
 * 比較前に長さを揃えることで、長さの違いから情報が漏れないようにする。
 */
function safeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < maxLength; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

function checkBasicAuth(req: NextRequest): boolean {
  const expectedUser = process.env.SITE_BASIC_AUTH_USER
  const expectedPassword = process.env.SITE_BASIC_AUTH_PASSWORD
  if (!expectedUser || !expectedPassword) {
    // 資格情報が未設定なら通さない（env.ts でも起動時に弾いているが、二重に守る）
    return false
  }

  const header = req.headers.get('authorization')
  if (!header?.startsWith('Basic ')) {
    return false
  }

  try {
    const decoded = atob(header.slice('Basic '.length))
    const separatorIndex = decoded.indexOf(':')
    if (separatorIndex < 0) return false

    const user = decoded.slice(0, separatorIndex)
    const password = decoded.slice(separatorIndex + 1)
    // 短絡評価を避け、両方を必ず比較する
    const userOk = safeEqual(user, expectedUser)
    const passwordOk = safeEqual(password, expectedPassword)
    return userOk && passwordOk
  } catch {
    return false
  }
}

function isAdminIpAllowed(req: NextRequest): boolean {
  const allowlist = process.env.ADMIN_IP_ALLOWLIST?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (!allowlist || allowlist.length === 0) {
    return true
  }

  const forwarded = req.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip')
  return ip !== null && allowlist.includes(ip)
}

export default function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl

  // ヘルスチェックは監視のため認証から除外する（内部情報を返さないこと）
  if (pathname === '/api/health') {
    return NextResponse.next()
  }

  if (process.env.SITE_ACCESS_MODE !== 'public' && !checkBasicAuth(req)) {
    return unauthorizedBasic()
  }

  if (pathname.startsWith('/admin') && !isAdminIpAllowed(req)) {
    return new NextResponse('アクセスが許可されていません', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // 静的アセットと Next.js 内部パスは対象外
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|images/).*)',
  ],
}
