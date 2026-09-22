'use client'

import { useRouter } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button.tsx'

/**
 * ログアウト。
 *
 * Auth.js の signOut は Cookie を消すだけなので、
 * 先にサーバー側のセッション行を失効させる（/api/auth/logout）。
 * この順序が逆だと、失効 API を呼ぶ前に認証情報が消えてしまう。
 */
export function LogoutButton() {
  const router = useRouter()
  const [isPending, setIsPending] = useState(false)

  async function handleLogout() {
    setIsPending(true)
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allDevices: false }),
      })
    } finally {
      await signOut({ redirect: false })
      router.push('/')
      router.refresh()
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleLogout} disabled={isPending}>
      {isPending ? 'ログアウト中…' : 'ログアウト'}
    </Button>
  )
}
