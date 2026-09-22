import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { InventoryForm, type InventoryFormValues } from '@/components/admin/inventory-form.tsx'
import { Card, CardTitle } from '@/components/ui/card.tsx'
import { InventoryStatusBadge } from '@/components/ui/status-badge.tsx'
import { AppError } from '@/lib/api/errors.ts'
import { hasPermission, PERMISSIONS } from '@/lib/auth/permissions.ts'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { getInventoryForAdmin, type InventoryDetail } from '@/modules/inventory/service.ts'
import { requireAdmin } from '@/server/guards.ts'

export const metadata: Metadata = { title: '在庫の詳細' }
export const dynamic = 'force-dynamic'

/** datetime-local が読める "YYYY-MM-DDTHH:mm" へ整形する（JST 表示） */
function toLocalInputValue(value: Date | null): string {
  if (!value) return ''
  const jst = new Date(value.getTime() + 9 * 60 * 60 * 1000)
  return jst.toISOString().slice(0, 16)
}

function toFormValues(item: InventoryDetail): InventoryFormValues {
  return {
    code: item.code,
    cardTitle: item.cardTitle,
    cardName: item.cardName,
    cardNumber: item.cardNumber ?? '',
    rarity: item.rarity ?? '',
    condition: item.condition,
    exchangePoints: String(item.exchangePoints),
    referencePriceYen: item.referencePriceYen === null ? '' : String(item.referencePriceYen),
    costPriceYen: item.costPriceYen === null ? '' : String(item.costPriceYen),
    storageLocation: item.storageLocation ?? '',
    frontImageKey: item.frontImageKey ?? '',
    backImageKey: item.backImageKey ?? '',
    acquisitionSource: item.acquisitionSource ?? '',
    acquiredFrom: item.acquiredFrom ?? '',
    acquiredAt: toLocalInputValue(item.acquiredAt),
    note: item.note ?? '',
  }
}

export default async function InventoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await requireAdmin(PERMISSIONS.INVENTORY_READ)
  const { id } = await params

  let item: InventoryDetail
  try {
    item = await getInventoryForAdmin(id)
  } catch (error) {
    if (AppError.isAppError(error) && error.httpStatus === 404) {
      notFound()
    }
    throw error
  }

  const canWrite = hasPermission(session.role, PERMISSIONS.INVENTORY_WRITE)
  const allocatedToPublished = item.allocatedCampaign !== null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">{item.cardName}</h1>
        <InventoryStatusBadge status={item.status} />
        <Link href="/admin/inventories" className="text-accent-400 ml-auto text-sm underline">
          在庫一覧へ戻る
        </Link>
      </div>

      <Card>
        <CardTitle>基本情報</CardTitle>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-base-100 text-xs">在庫コード</dt>
            <dd className="font-mono">{item.code}</dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">登録日時</dt>
            <dd>
              <time dateTime={item.createdAt.toISOString()}>
                {formatDateTimeJst(item.createdAt)}
              </time>
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">割当先オリパ</dt>
            <dd>
              {item.allocatedCampaign ? (
                <Link
                  href={`/admin/oripas/${item.allocatedCampaign.id}`}
                  className="text-accent-400 underline"
                >
                  {item.allocatedCampaign.name}
                </Link>
              ) : (
                '未割当'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">備考</dt>
            <dd className="break-all">{item.note ?? '—'}</dd>
          </div>
        </dl>
      </Card>

      {item.frontImageKey ? (
        <Card>
          <CardTitle>画像（プレースホルダー）</CardTitle>
          <div className="mt-3 flex gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- 動的生成 SVG のため最適化不要 */}
            <img
              src={`/api/placeholder/${encodeURIComponent(item.frontImageKey)}`}
              alt={`${item.cardName} の表面画像（開発用プレースホルダー）`}
              width={120}
              height={168}
              className="rounded-lg"
            />
            {item.backImageKey ? (
              // eslint-disable-next-line @next/next/no-img-element -- 同上
              <img
                src={`/api/placeholder/${encodeURIComponent(item.backImageKey)}`}
                alt={`${item.cardName} の裏面画像（開発用プレースホルダー）`}
                width={120}
                height={168}
                className="rounded-lg"
              />
            ) : null}
          </div>
        </Card>
      ) : null}

      {canWrite ? (
        <Card>
          <CardTitle>在庫を編集</CardTitle>
          <div className="mt-4">
            <InventoryForm
              mode="edit"
              inventoryId={item.id}
              initialValues={toFormValues(item)}
              initialStatus={item.status}
              locked={
                allocatedToPublished
                  ? 'このカードはオリパへ割り当て済みです。公開済みオリパの場合、交換ポイントと状態は変更できません。'
                  : null
              }
            />
          </div>
        </Card>
      ) : (
        <p className="text-base-100 text-sm">在庫を編集する権限がありません。</p>
      )}
    </div>
  )
}
