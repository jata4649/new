import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ShippingControls } from '@/components/admin/shipping-controls.tsx'
import { PrizeThumb } from '@/components/prizes/prize-thumb.tsx'
import { Alert } from '@/components/ui/alert.tsx'
import { Card, CardTitle } from '@/components/ui/card.tsx'
import { ShippingStatusBadge } from '@/components/ui/status-badge.tsx'
import { hasPermission, PERMISSIONS } from '@/lib/auth/permissions.ts'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { getShipmentForAdmin } from '@/modules/shipping/queries.ts'
import { requireAdmin } from '@/server/guards.ts'

export const metadata: Metadata = { title: '発送申請の詳細' }
export const dynamic = 'force-dynamic'

/**
 * 発送申請の詳細と作業画面。
 *
 * 宛先は申請時点のスナップショット。利用者が住所を変えても
 * この申請の宛先は変わらない（変わったら「どこへ送るか」が揺れてしまう）。
 */
export default async function AdminShippingRequestPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await requireAdmin(PERMISSIONS.SHIPPING_READ)
  const { id } = await params

  const shipment = await getShipmentForAdmin(id)
  if (!shipment) {
    notFound()
  }

  const canUpdate = hasPermission(session.role, PERMISSIONS.SHIPPING_UPDATE)
  const activeItems = shipment.items.filter((item) => item.cancelledAt === null)
  const displayItems = activeItems.length > 0 ? activeItems : shipment.items

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">発送申請</h1>
        <ShippingStatusBadge status={shipment.status} />
        <Link
          href="/admin/shipping-requests"
          className="text-accent-400 ml-auto text-sm underline"
        >
          一覧へ戻る
        </Link>
      </div>

      <Card>
        <CardTitle>お届け先（申請時点の記録）</CardTitle>
        <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-base-100 text-xs">宛名</dt>
            <dd className="font-bold">{shipment.recipientName}</dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">電話番号</dt>
            <dd className="tabular-nums">{shipment.phoneNumber}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-base-100 text-xs">住所</dt>
            <dd>
              〒{shipment.postalCode} {shipment.prefecture}
              {shipment.city}
              {shipment.addressLine1}
              {shipment.addressLine2 ? ` ${shipment.addressLine2}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">申請者</dt>
            <dd>
              {shipment.userDisplayName} / {shipment.userEmail}
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">申請日時</dt>
            <dd>
              <time dateTime={shipment.createdAt.toISOString()}>
                {formatDateTimeJst(shipment.createdAt)}
              </time>
            </dd>
          </div>
        </dl>
      </Card>

      <Card>
        <CardTitle>商品（{displayItems.length} 点）</CardTitle>
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {displayItems.map((item) => (
            <li key={item.userPrizeId}>
              <div className="border-base-800 space-y-2 rounded-lg border p-2">
                <PrizeThumb
                  imageKey={item.imageKey}
                  effectTier={item.effectTier}
                  tierName={item.effectTier}
                />
                <p className="text-sm font-bold">{item.name}</p>
                {item.cancelledAt ? <p className="text-xs text-red-300">取消済み</p> : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {shipment.trackingNumber ? (
        <Card>
          <CardTitle>配送情報</CardTitle>
          <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-base-100 text-xs">配送業者</dt>
              <dd>{shipment.carrier}</dd>
            </div>
            <div>
              <dt className="text-base-100 text-xs">追跡番号</dt>
              <dd className="tabular-nums">{shipment.trackingNumber}</dd>
            </div>
            <div>
              <dt className="text-base-100 text-xs">発送日時</dt>
              <dd>
                {shipment.shippedAt ? (
                  <time dateTime={shipment.shippedAt.toISOString()}>
                    {formatDateTimeJst(shipment.shippedAt)}
                  </time>
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </dl>
        </Card>
      ) : null}

      {shipment.cancelReason ? (
        <Alert tone="warning" title="取消し済み">
          {shipment.cancelReason}
        </Alert>
      ) : null}

      {shipment.adminNote ? (
        <Card>
          <CardTitle>作業メモ</CardTitle>
          <p className="mt-2 text-sm">{shipment.adminNote}</p>
        </Card>
      ) : null}

      {canUpdate ? (
        <Card>
          <CardTitle>発送作業</CardTitle>
          <p className="text-base-100/70 mt-1 mb-4 text-xs">
            申請受付 → 検品中 → 梱包中 → 発送済み → 配達完了 の順にのみ進められます。
            巻き戻しはできません。
          </p>
          <ShippingControls
            shipmentId={shipment.id}
            status={shipment.status}
            carrier={shipment.carrier}
            trackingNumber={shipment.trackingNumber}
          />
        </Card>
      ) : (
        <Alert tone="info">発送作業を行う権限がありません（参照のみ）。</Alert>
      )}
    </div>
  )
}
