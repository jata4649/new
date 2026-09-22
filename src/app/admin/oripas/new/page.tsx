import type { Metadata } from 'next'
import Link from 'next/link'

import { OripaForm } from '@/components/admin/oripa-form.tsx'
import { Card, CardTitle } from '@/components/ui/card.tsx'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { requireAdmin } from '@/server/guards.ts'

export const metadata: Metadata = { title: 'オリパを作成' }
export const dynamic = 'force-dynamic'

export default async function NewOripaPage() {
  await requireAdmin(PERMISSIONS.ORIPA_WRITE)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">オリパを作成</h1>
        <Link href="/admin/oripas" className="text-accent-400 text-sm underline">
          オリパ一覧へ戻る
        </Link>
      </div>

      <ol className="text-base-100 flex flex-wrap gap-2 text-xs">
        <li className="bg-base-800 rounded px-2 py-1 font-bold">1. 下書きを作成</li>
        <li className="bg-base-900 rounded px-2 py-1">2. 景品を割り当てる</li>
        <li className="bg-base-900 rounded px-2 py-1">3. 公開条件を確認</li>
        <li className="bg-base-900 rounded px-2 py-1">4. 公開</li>
      </ol>

      <Card>
        <CardTitle>基本情報と景品ランク</CardTitle>
        <div className="mt-4">
          <OripaForm />
        </div>
      </Card>
    </div>
  )
}
