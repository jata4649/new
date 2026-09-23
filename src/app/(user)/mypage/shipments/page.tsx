import type { Metadata } from 'next'
import Link from 'next/link'

import { ShipmentCancelButton } from '@/components/shipping/shipment-cancel-button.tsx'
import { Alert } from '@/components/ui/alert.tsx'
import { Card } from '@/components/ui/card.tsx'
import { ShippingStatusBadge } from '@/components/ui/status-badge.tsx'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { listUserShipments } from '@/modules/shipping/queries.ts'
import { shipmentListQuerySchema } from '@/modules/shipping/schema.ts'
import { requireUser } from '@/server/guards.ts'

export const metadata: Metadata = { title: '発送申請' }
export const dynamic = 'force-dynamic'

/**
 * 発送申請の一覧。
 *
 * 表示している宛先は申請時点のスナップショット。
 * 配送先を編集・削除しても、過去の申請の宛先は変わらない。
 */
export default async function ShipmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireUser('/mypage/shipments')

  const raw = await searchParams
  const parsed = shipmentListQuerySchema.safeParse(raw)
  const query = parsed.success ? parsed.data : shipmentListQuerySchema.parse({})

  const result = await listUserShipments(session.id, query)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">発送申請</h1>
        <Link href="/mypage/prizes" className="text-accent-400 text-sm underline">
          当選商品
        </Link>
        <Link href="/mypage/addresses" className="text-accent-400 text-sm underline">
          配送先
        </Link>
      </div>

      {result.items.length === 0 ? (
        <Card>
          <p className="text-base-100 text-sm">まだ発送申請はありません。</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {result.items.map((shipment) => {
            const activeItems = shipment.items.filter((item) => item.cancelledAt === null)
            const displayItems = activeItems.length > 0 ? activeItems : shipment.items

            return (
              <li key={shipment.id}>
                <Card className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <ShippingStatusBadge status={shipment.status} />
                    <p className="text-base-100 text-xs">
                      <time dateTime={shipment.createdAt.toISOString()}>
                        {formatDateTimeJst(shipment.createdAt)} 申請
                      </time>
                    </p>
                  </div>

                  <div>
                    <p className="text-base-100 text-xs">お届け先</p>
                    <p className="text-sm">
                      {shipment.recipientName} / 〒{shipment.postalCode} {shipment.prefecture}
                      {shipment.city}
                      {shipment.addressLine1}
                      {shipment.addressLine2 ? ` ${shipment.addressLine2}` : ''}
                    </p>
                  </div>

                  <div>
                    <p className="text-base-100 text-xs">商品（{displayItems.length} 点）</p>
                    <ul className="mt-1 space-y-1">
                      {displayItems.map((item) => (
                        <li key={item.userPrizeId} className="text-sm">
                          {item.name}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {shipment.trackingNumber ? (
                    <div>
                      <p className="text-base-100 text-xs">追跡番号</p>
                      <p className="text-sm tabular-nums">
                        {shipment.carrier} {shipment.trackingNumber}
                      </p>
                      {shipment.shippedAt ? (
                        <p className="text-base-100 text-xs">
                          <time dateTime={shipment.shippedAt.toISOString()}>
                            {formatDateTimeJst(shipment.shippedAt)} 発送
                          </time>
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {shipment.cancelReason ? (
                    <Alert tone="warning">取消し理由: {shipment.cancelReason}</Alert>
                  ) : null}

                  {shipment.status === 'REQUESTED' ? (
                    <div className="border-base-800 border-t pt-3">
                      <ShipmentCancelButton shipmentId={shipment.id} />
                    </div>
                  ) : shipment.status === 'CHECKING' || shipment.status === 'PACKING' ? (
                    <p className="text-base-100/70 text-xs">
                      発送の準備に入っているため、この画面からは取り消せません。
                    </p>
                  ) : null}
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
              href={`/mypage/shipments?page=${result.page - 1}`}
              className="border-base-700 rounded-lg border px-3 py-2 text-sm"
            >
              前へ
            </Link>
          ) : null}
          {result.page < result.totalPages ? (
            <Link
              href={`/mypage/shipments?page=${result.page + 1}`}
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
