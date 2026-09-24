import type { Metadata } from 'next'
import Link from 'next/link'

import { Card } from '@/components/ui/card.tsx'
import { InventoryStatusBadge } from '@/components/ui/status-badge.tsx'
import { hasPermission, PERMISSIONS } from '@/lib/auth/permissions.ts'
import { formatPoints, formatYen } from '@/lib/money/points.ts'
import { inventoryListQuerySchema } from '@/modules/inventory/schema.ts'
import { listInventories } from '@/modules/inventory/service.ts'
import { requireAdmin } from '@/server/guards.ts'

export const metadata: Metadata = { title: 'カード在庫管理' }
export const dynamic = 'force-dynamic'

const STATUS_OPTIONS = [
  { value: '', label: 'すべて' },
  { value: 'AVAILABLE', label: '在庫あり' },
  { value: 'ALLOCATED', label: 'オリパ割当済み' },
  { value: 'WON', label: '当選済み' },
  { value: 'SHIPPING_REQUESTED', label: '発送申請中' },
  { value: 'SHIPPED', label: '発送済み' },
  { value: 'EXCHANGED', label: 'ポイント交換済み' },
  { value: 'DAMAGED', label: '破損' },
  { value: 'LOST', label: '紛失' },
]

export default async function AdminInventoriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireAdmin(PERMISSIONS.INVENTORY_READ)

  const raw = await searchParams
  const parsed = inventoryListQuerySchema.safeParse(raw)
  const query = parsed.success ? parsed.data : inventoryListQuerySchema.parse({})

  const result = await listInventories(query)
  const canWrite = hasPermission(session.role, PERMISSIONS.INVENTORY_WRITE)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">カード在庫管理</h1>
        {canWrite ? (
          <Link
            href="/admin/inventories/new"
            className="bg-accent-500 text-base-950 ml-auto rounded-lg px-4 py-2 text-sm font-bold"
          >
            在庫を登録
          </Link>
        ) : null}
      </div>

      <p className="text-base-100 text-sm">
        在庫は物理個体ごとに 1 件です。同じ物理在庫を複数のオリパへ割り当てることはできません。
      </p>

      <form method="get" className="flex flex-wrap gap-2">
        <label htmlFor="q" className="sr-only">
          在庫コード・カード名で検索
        </label>
        <input
          id="q"
          name="q"
          defaultValue={query.q ?? ''}
          placeholder="在庫コード・カード名で検索"
          className="border-base-700 bg-base-900 h-10 min-w-56 flex-1 rounded-lg border px-3 text-base"
        />
        <label htmlFor="status" className="sr-only">
          在庫状態
        </label>
        <select
          id="status"
          name="status"
          defaultValue={query.status ?? ''}
          className="border-base-700 bg-base-900 h-10 rounded-lg border px-3 text-base"
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="bg-accent-500 text-base-950 h-10 rounded-lg px-4 text-sm font-bold"
        >
          検索
        </button>
      </form>

      <p className="text-base-100 text-sm">
        {result.total.toLocaleString('ja-JP')} 件中 {result.items.length} 件を表示（
        {result.page} / {result.totalPages} ページ）
      </p>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-base-800 text-base-100 border-b text-xs">
            <tr>
              <th scope="col" className="px-4 py-2">
                在庫コード
              </th>
              <th scope="col" className="px-4 py-2">
                カード名
              </th>
              <th scope="col" className="px-4 py-2">
                レアリティ
              </th>
              <th scope="col" className="px-4 py-2">
                交換ポイント
              </th>
              <th scope="col" className="px-4 py-2">
                参考価格
              </th>
              <th scope="col" className="px-4 py-2">
                状態
              </th>
              <th scope="col" className="px-4 py-2">
                割当先
              </th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((item) => (
              <tr key={item.id} className="border-base-800/50 border-b last:border-0">
                <td className="px-4 py-2 font-mono text-xs">
                  <Link
                    href={`/admin/inventories/${item.id}`}
                    className="text-accent-400 underline"
                  >
                    {item.code}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  <span className="font-bold">{item.cardName}</span>
                  <span className="text-base-100 block text-xs">{item.cardTitle}</span>
                </td>
                <td className="px-4 py-2 text-xs">{item.rarity ?? '—'}</td>
                <td className="px-4 py-2 tabular-nums">{formatPoints(item.exchangePoints)}</td>
                <td className="px-4 py-2 tabular-nums">
                  {item.referencePriceYen === null ? '—' : formatYen(item.referencePriceYen)}
                </td>
                <td className="px-4 py-2">
                  <InventoryStatusBadge status={item.status} />
                </td>
                <td className="px-4 py-2 text-xs">
                  {item.allocatedCampaign ? (
                    <Link
                      href={`/admin/oripas/${item.allocatedCampaign.id}`}
                      className="text-accent-400 underline"
                    >
                      {item.allocatedCampaign.name}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
            {result.items.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-base-100 px-4 py-6 text-center">
                  該当する在庫がありません。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>

      {result.totalPages > 1 ? (
        <nav aria-label="ページ送り" className="flex gap-2">
          {result.page > 1 ? (
            <Link
              href={`/admin/inventories?page=${result.page - 1}`}
              className="border-base-700 rounded-lg border px-3 py-2 text-sm"
            >
              前へ
            </Link>
          ) : null}
          {result.page < result.totalPages ? (
            <Link
              href={`/admin/inventories?page=${result.page + 1}`}
              className="border-base-700 rounded-lg border px-3 py-2 text-sm"
            >
              次へ
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  )
}
