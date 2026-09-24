import type { Metadata } from 'next'
import Link from 'next/link'

import { ExchangeNoticeRegion } from '@/components/prizes/exchange-notice.tsx'
import { PrizeExchangeButton } from '@/components/prizes/prize-exchange-button.tsx'
import { PrizeThumb } from '@/components/prizes/prize-thumb.tsx'
import { ShippingRequestPanel } from '@/components/shipping/shipping-request-panel.tsx'
import { Alert } from '@/components/ui/alert.tsx'
import { Card } from '@/components/ui/card.tsx'
import { EffectTierBadge, PrizeStatusBadge } from '@/components/ui/status-badge.tsx'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { formatPoints } from '@/lib/money/points.ts'
import { listAddresses } from '@/modules/addresses/queries.ts'
import { listUserPrizes } from '@/modules/prizes/queries.ts'
import { prizeListQuerySchema } from '@/modules/prizes/schema.ts'
import { requireUser } from '@/server/guards.ts'

export const metadata: Metadata = { title: '当選商品' }
export const dynamic = 'force-dynamic'

const STATUS_OPTIONS = [
  { value: '', label: 'すべて' },
  { value: 'UNDECIDED', label: '未選択' },
  { value: 'EXCHANGED', label: 'ポイント交換済み' },
  { value: 'SHIPPING_REQUESTED', label: '発送申請中' },
  { value: 'SHIPPED', label: '発送済み' },
]

/**
 * 当選商品一覧。
 *
 * 未選択（UNDECIDED）を先頭に出す。利用者が最初に見たいのは
 * 「まだ決めていないもの」であり、処理済みの履歴ではないため。
 *
 * 表示している名前・画像・交換ポイントはすべて抽選時のスナップショット。
 * 在庫マスタが変わっても、手元の当選商品の見え方は変わらない。
 */
export default async function PrizesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireUser('/mypage/prizes')

  const raw = await searchParams
  const parsed = prizeListQuerySchema.safeParse(raw)
  const query = parsed.success ? parsed.data : prizeListQuerySchema.parse({})

  const [result, addresses] = await Promise.all([
    listUserPrizes(session.id, query),
    listAddresses(session.id),
  ])

  /*
   * 発送申請の候補。
   *
   * 絞り込みの結果ではなく「未選択かつ発送可能」を毎回引き直す。
   * 「ポイント交換済み」で絞り込んでいるときに申請パネルが空になると、
   * 申請できないのか候補が無いのか分からなくなるため。
   */
  const shippable = await listUserPrizes(session.id, {
    page: 1,
    perPage: 100,
    status: 'UNDECIDED',
  })
  const shippablePrizes = shippable.items
    .filter((prize) => prize.shippable)
    .map((prize) => ({
      id: prize.id,
      name: prize.name,
      exchangePoints: prize.exchangePoints,
    }))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">当選商品</h1>
        <Link href="/mypage/draws" className="text-accent-400 text-sm underline">
          抽選履歴
        </Link>
        <Link href="/mypage/shipments" className="text-accent-400 text-sm underline">
          発送申請
        </Link>
        <Link href="/mypage/addresses" className="text-accent-400 text-sm underline">
          配送先
        </Link>
      </div>

      {/* 交換の結果。一覧の再描画で消えないよう、一覧の外に置く */}
      <ExchangeNoticeRegion />

      {result.undecidedTotal > 0 ? (
        <Alert tone="info">
          未選択の商品が {result.undecidedTotal} 件あります。
          ポイント交換または発送申請を選んでください。
        </Alert>
      ) : null}

      <ShippingRequestPanel prizes={shippablePrizes} addresses={addresses} />

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
        <button
          type="submit"
          className="bg-accent-500 text-base-950 h-10 rounded-lg px-4 text-sm font-bold"
        >
          絞り込む
        </button>
      </form>

      {result.items.length === 0 ? (
        <Card>
          <p className="text-base-100 text-sm">該当する当選商品がありません。</p>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {result.items.map((prize) => (
            <li key={prize.id}>
              <Card className="flex h-full gap-3">
                {/*
                  画像を持たない景品でも枠は必ず出す。
                  出し分けると、画像なしの行だけ本文が左へ寄って一覧がガタつく。
                */}
                <div className="w-[72px] shrink-0">
                  <PrizeThumb
                    imageKey={prize.imageKey}
                    effectTier={prize.effectTier}
                    tierName={prize.effectTier}
                  />
                </div>

                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <EffectTierBadge tier={prize.effectTier} label={prize.effectTier} />
                    <PrizeStatusBadge status={prize.status} />
                  </div>

                  <p className="text-sm font-bold">{prize.name}</p>
                  <p className="text-base-100 text-xs">
                    {prize.isPhysical ? '物理カード' : 'ポイント還元アイテム'} /{' '}
                    <Link
                      href={`/draws/${prize.drawTransactionId}`}
                      className="text-accent-400 underline"
                    >
                      {prize.campaignName}
                    </Link>
                  </p>
                  <p className="text-base-100 text-xs">
                    <time dateTime={prize.createdAt.toISOString()}>
                      {formatDateTimeJst(prize.createdAt)}
                    </time>
                  </p>

                  {prize.status === 'UNDECIDED' ? (
                    <div className="space-y-2">
                      <PrizeExchangeButton
                        prizeId={prize.id}
                        prizeName={prize.name}
                        exchangePoints={prize.exchangePoints}
                      />
                      <p className="text-base-100/70 text-xs">
                        {prize.shippable
                          ? '発送を希望する場合は、上の「発送申請」からまとめて申請してください。'
                          : 'この商品は発送の対象外です（ポイント交換のみ）。'}
                      </p>
                    </div>
                  ) : (
                    <p className="text-base-100 text-xs tabular-nums">
                      交換ポイント: {formatPoints(prize.exchangePoints)}
                      {prize.exchangedAt ? (
                        <>
                          {' / '}
                          <time dateTime={prize.exchangedAt.toISOString()}>
                            {formatDateTimeJst(prize.exchangedAt)} に交換
                          </time>
                        </>
                      ) : null}
                    </p>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {result.totalPages > 1 ? (
        <nav aria-label="ページ送り" className="flex gap-2">
          {result.page > 1 ? (
            <Link
              href={`/mypage/prizes?page=${result.page - 1}`}
              className="border-base-700 rounded-lg border px-3 py-2 text-sm"
            >
              前へ
            </Link>
          ) : null}
          {result.page < result.totalPages ? (
            <Link
              href={`/mypage/prizes?page=${result.page + 1}`}
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
