import type { Metadata, Viewport } from 'next'

import { publicEnv } from '@/lib/config/env.ts'

import './globals.css'

export const metadata: Metadata = {
  title: {
    default: publicEnv.NEXT_PUBLIC_SITE_NAME,
    template: `%s | ${publicEnv.NEXT_PUBLIC_SITE_NAME}`,
  },
  description: 'トレーディングカードのオンラインオリパ（クローズドテスト環境）',
  // クローズドテスト中は検索結果に出さない
  robots: { index: false, follow: false, nocache: true },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // ピンチズームを禁止しない（アクセシビリティ要件）
  maximumScale: 5,
  themeColor: '#0b1020',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className="min-h-dvh antialiased">
        {publicEnv.NEXT_PUBLIC_TEST_MODE_BANNER ? (
          <div
            role="status"
            className="bg-amber-500 px-4 py-2 text-center text-sm font-bold text-black"
          >
            テスト環境です。現金決済は行われず、ポイントはすべてテスト用です。
          </div>
        ) : null}
        {children}
      </body>
    </html>
  )
}
