import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // 本番ビルドで型エラーを握り潰さない（金銭を扱うため厳格に倒す）。
  // Lint は next build から独立させ、CI で `pnpm lint` として実行する。
  typescript: { ignoreBuildErrors: false },

  // サーバー内部情報の露出を減らす
  poweredByHeader: false,

  // Prisma 7 の生成クライアントは Node ランタイムでのみ動作する
  serverExternalPackages: ['@prisma/client', '@node-rs/argon2'],

  images: {
    // MVP はローカル配信。将来 CDN / S3 互換へ差し替える。
    remotePatterns: [],
    formats: ['image/webp'],
  },

  async headers() {
    const securityHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), payment=()',
      },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    ]

    // クローズドテスト中は検索エンジンに拾わせない（要件: 一般公開しない）
    if (process.env.SITE_ACCESS_MODE !== 'public') {
      securityHeaders.push({ key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' })
    }

    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
