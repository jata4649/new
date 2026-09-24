import Link from 'next/link'

import { publicEnv } from '@/lib/config/env.ts'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-[80dvh] w-full max-w-md flex-col justify-center px-4 py-10">
      <Link href="/" className="mb-6 text-center text-lg font-bold">
        {publicEnv.NEXT_PUBLIC_SITE_NAME}
      </Link>
      {children}
    </main>
  )
}
