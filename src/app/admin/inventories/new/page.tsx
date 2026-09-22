import type { Metadata } from 'next'
import Link from 'next/link'

import { EMPTY_INVENTORY_FORM, InventoryForm } from '@/components/admin/inventory-form.tsx'
import { Card, CardTitle } from '@/components/ui/card.tsx'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { requireAdmin } from '@/server/guards.ts'

export const metadata: Metadata = { title: '在庫を登録' }
export const dynamic = 'force-dynamic'

export default async function NewInventoryPage() {
  await requireAdmin(PERMISSIONS.INVENTORY_WRITE)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">在庫を登録</h1>
        <Link href="/admin/inventories" className="text-accent-400 text-sm underline">
          在庫一覧へ戻る
        </Link>
      </div>

      <Card>
        <CardTitle>カード情報</CardTitle>
        <div className="mt-4">
          <InventoryForm mode="create" initialValues={EMPTY_INVENTORY_FORM} />
        </div>
      </Card>
    </div>
  )
}
