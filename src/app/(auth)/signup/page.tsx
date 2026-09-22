import type { Metadata } from 'next'

import { SignupForm } from '@/components/auth/signup-form.tsx'

export const metadata: Metadata = { title: '新規会員登録' }

export default function SignupPage() {
  return <SignupForm />
}
