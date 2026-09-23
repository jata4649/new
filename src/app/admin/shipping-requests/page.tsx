import type { Metadata } from 'next'
import Link from 'next/link'

import { Alert } from '@/components/ui/alert.tsx'
import { Card } from '@/components/ui/card.tsx'
import { ShippingStatusBadge } from '@/components/ui/status-badge.tsx'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { listShipmentsForAdmin } from '@/modules/shipping/queries.ts'
import { adminShipmentListQuerySchema } from '@/modules/shipping/schema.ts'
import { requireAdmin } from '@/server/guards.ts'

export const metadata: Metadata = { title: '発送申請' }
export const dynamic = 'force-dynamic'

const STATUS_OPTIONS = [
  { value: '', label: 'すべて' },
  { value: 'REQUESTED', label: '申請受付' },
  { value: 'CHECKING', label: '検品中' },
  { value: 'PACKING', label: '梱包中' },
  { value: 'SHIPPED', label: '発送済み' },
  { value: 'DELIVERED', label: '配達完了' },
  { value: 'CANCELLED', label: '取消済み' },
]

/**
 * 発送申請一覧（管理画面）。
 *
 * 古い申請から並べる。待たせている順に処理するのが運用上も正しい。
 * 未処理件数は絞り込みに関わらず全体を数えるので、
 * 絞り込んだままでも「あと何件残っているか」が見える。
 */
export default async function AdminShippingRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin(PERMISSIONS.SHIPPING_READ)

  const raw = await searchParams
  const parsed = adminShipmentListQuerySchema.safeParse(raw)
  const query = parsed.success ? parsed.data : adminShipmentListQuerySchema.parse({})

  const result = await listShipmentsForAdmin(query)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">発送申請</h1>

      {result.pendingTotal > 0 ? (
        <Alert tone="info">未処理の発送申請が {result.pendingTotal} 件あります。</Alert>
      ) : (
        <Alert tone="success">未処理の発送申請はありません。</Alert>
      )}

      <form method="get" className="flex flex-wrap gap-2">
        <label htmlFor="status" className="sr-only">
          状態で絞り込み
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
        <label htmlFor="userEmail" className="sr-only">
          メールアドレスで絞り込み
        </label>
        <input
          id="userEmail"
          name="userEmail"
          defaultValue={query.userEmail ?? ''}
          placeholder="メールアドレス"
          className="border-base-700 bg-base-900 h-10 rounded-lg border px-3 text-base"
        />
        <button
          type="submit"
          className="bg-accent-500 text-base-950 h-10 rounded-lg px-4 text-sm font-bold"
        >
          絞り込む
        </button>
      </form>

      {result.items.length === 0 ? (
        <Card>
          <p className="text-base-100 text-sm">該当する発送申請がありません。</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {result.items.map((shipment) => {
            const activeCount = shipment.items.filter(
              (item) => item.cancelledAt === null,
            ).length

            return (
              <li key={shipment.id}>
                <Card className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <ShippingStatusBadge status={shipment.status} />
                    <Link
                      href={`/admin/shipping-requests/${shipment.id}`}
                      className="text-accent-400 font-bold underline"
                    >
                      {shipment.recipientName} 宛（{activeCount} 点）
                    </Link>
                  </div>
                  <p className="text-base-100 text-sm">
                    {shipment.userDisplayName} / {shipment.userEmail}
                  </p>
                  <p className="text-base-100 text-xs">
                    <time dateTime={shipment.createdAt.toISOString()}>
                      {formatDateTimeJst(shipment.createdAt)} 申請
                    </time>
                    {shipment.trackingNumber ? (
                      <span className="ml-2 tabular-nums">
                        {shipment.carrier} {shipment.trackingNumber}
                      </span>
                    ) : null}
                  </p>
                </Card>
              </li>
            )
          })}
        </ul>
      )}

      {result.totalPages > 1 ? (
        <nav aria-label="ページ送り" className="flex gap-2">
          {result.page > 1 ? (
            <Link
              href={`/admin/shipping-requests?page=${result.page - 1}`}
              className="border-base-700 rounded-lg border px-3 py-2 text-sm"
            >
              前へ
            </Link>
          ) : null}
          {result.page < result.totalPages ? (
            <Link
              href={`/admin/shipping-requests?page=${result.page + 1}`}
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
