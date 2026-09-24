import type { Metadata } from 'next'

import { LoginForm } from '@/components/auth/login-form.tsx'

export const metadata: Metadata = { title: 'ログイン' }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>
}) {
  const params = await searchParams

  return (
    <LoginForm
      callbackUrl={params.callbackUrl ?? '/mypage'}
      initialError={params.error ? 'ログインに失敗しました' : undefined}
    />
  )
}
