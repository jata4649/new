import type { Metadata } from 'next'
import Link from 'next/link'

import { Card } from '@/components/ui/card.tsx'
import { CampaignStatusBadge } from '@/components/ui/status-badge.tsx'
import { hasPermission, PERMISSIONS } from '@/lib/auth/permissions.ts'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { formatPoints } from '@/lib/money/points.ts'
import { oripaListQuerySchema } from '@/modules/oripa/schema.ts'
import { listOripasForAdmin } from '@/modules/oripa/service.ts'
import { requireAdmin } from '@/server/guards.ts'

export const metadata: Metadata = { title: 'オリパ管理' }
export const dynamic = 'force-dynamic'

const STATUS_OPTIONS = [
  { value: '', label: 'すべて' },
  { value: 'DRAFT', label: '下書き' },
  { value: 'SCHEDULED', label: '販売前' },
  { value: 'ACTIVE', label: '販売中' },
  { value: 'SUSPENDED', label: '停止中' },
  { value: 'SOLD_OUT', label: '完売' },
  { value: 'ENDED', label: '販売終了' },
]

export default async function AdminOripasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireAdmin(PERMISSIONS.ORIPA_READ)

  const raw = await searchParams
  const parsed = oripaListQuerySchema.safeParse(raw)
  const query = parsed.success ? parsed.data : oripaListQuerySchema.parse({})

  const result = await listOripasForAdmin(query)
  const canWrite = hasPermission(session.role, PERMISSIONS.ORIPA_WRITE)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">オリパ管理</h1>
        {canWrite ? (
          <Link
            href="/admin/oripas/new"
            className="bg-accent-500 text-base-950 ml-auto rounded-lg px-4 py-2 text-sm font-bold"
          >
            オリパを作成
          </Link>
        ) : null}
      </div>

      <p className="text-base-100 text-sm">
        公開すると価格・総口数・景品構成は変更できなくなります（DB トリガでも拒否されます）。
      </p>

      <form method="get" className="flex flex-wrap gap-2">
        <label htmlFor="q" className="sr-only">
          名称・スラッグで検索
        </label>
        <input
          id="q"
          name="q"
          defaultValue={query.q ?? ''}
          placeholder="名称・スラッグで検索"
          className="border-base-700 bg-base-900 h-10 min-w-56 flex-1 rounded-lg border px-3 text-base"
        />
        <label htmlFor="status" className="sr-only">
          状態
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

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-base-800 text-base-100 border-b text-xs">
            <tr>
              <th scope="col" className="px-4 py-2">
                名称
              </th>
              <th scope="col" className="px-4 py-2">
                状態
              </th>
              <th scope="col" className="px-4 py-2">
                1 口価格
              </th>
              <th scope="col" className="px-4 py-2">
                残り / 総口数
              </th>
              <th scope="col" className="px-4 py-2">
                生成スロット
              </th>
              <th scope="col" className="px-4 py-2">
                販売期間
              </th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((item) => (
              <tr key={item.id} className="border-base-800/50 border-b last:border-0">
                <td className="px-4 py-2">
                  <Link
                    href={`/admin/oripas/${item.id}`}
                    className="text-accent-400 font-bold underline"
                  >
                    {item.name}
                  </Link>
                  <span className="text-base-100 block font-mono text-xs">{item.slug}</span>
                </td>
                <td className="px-4 py-2">
                  <CampaignStatusBadge status={item.status} />
                </td>
                <td className="px-4 py-2 tabular-nums">{formatPoints(item.pricePoints)}</td>
                <td className="px-4 py-2 tabular-nums">
                  {item.remainingSlots.toLocaleString('ja-JP')} /{' '}
                  {item.totalSlots.toLocaleString('ja-JP')}
                </td>
                <td className="px-4 py-2 tabular-nums">
                  {item.generatedSlots.toLocaleString('ja-JP')}
                  {item.generatedSlots !== item.totalSlots ? (
                    <span className="ml-1 text-xs text-amber-300">未完了</span>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-xs whitespace-nowrap">
                  <time dateTime={item.salesStartAt.toISOString()}>
                    {formatDateTimeJst(item.salesStartAt)}
                  </time>
                  <span className="mx-1">〜</span>
                  <time dateTime={item.salesEndAt.toISOString()}>
                    {formatDateTimeJst(item.salesEndAt)}
                  </time>
                </td>
              </tr>
            ))}
            {result.items.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-base-100 px-4 py-6 text-center">
                  該当するオリパがありません。
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
              href={`/admin/oripas?page=${result.page - 1}`}
              className="border-base-700 rounded-lg border px-3 py-2 text-sm"
            >
              前へ
            </Link>
          ) : null}
          {result.page < result.totalPages ? (
            <Link
              href={`/admin/oripas?page=${result.page + 1}`}
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
