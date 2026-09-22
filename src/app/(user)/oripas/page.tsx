import type { Metadata } from 'next'
import Link from 'next/link'

import { Card } from '@/components/ui/card.tsx'
import { SaleStateBadge } from '@/components/ui/status-badge.tsx'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { formatPoints } from '@/lib/money/points.ts'
import { listPublicOripas } from '@/modules/oripa/queries.ts'

export const metadata: Metadata = { title: 'オリパ一覧' }
export const dynamic = 'force-dynamic'

/**
 * オリパ一覧（未ログインでも閲覧できる）。
 *
 * 抽選順（draw_order）やシードは、サーバー側の select の時点で読んでいない。
 * 「うっかり渡してしまう」経路を作らないため、参照用の型にも含めていない。
 */
export default async function OripasPage() {
  const oripas = await listPublicOripas()

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">オリパ一覧</h1>

      <p className="text-base-100 text-sm">
        クローズドテスト環境です。現金での購入・買取りは行いません。ポイントはテスト用です。
      </p>

      {oripas.length === 0 ? (
        <Card>
          <p className="text-base-100 text-sm">現在公開中のオリパはありません。</p>
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {oripas.map((oripa) => {
            const soldRatio =
              oripa.totalSlots > 0
                ? Math.round(
                    ((oripa.totalSlots - oripa.remainingSlots) / oripa.totalSlots) * 100,
                  )
                : 0

            return (
              <li key={oripa.id}>
                <Card className="h-full space-y-3">
                  <div className="flex items-start gap-3">
                    {oripa.thumbnailKey ? (
                      // eslint-disable-next-line @next/next/no-img-element -- 動的生成 SVG のため最適化不要
                      <img
                        src={`/api/placeholder/${encodeURIComponent(oripa.thumbnailKey)}`}
                        alt=""
                        width={64}
                        height={90}
                        className="rounded-lg"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <h2 className="font-bold">
                        <Link
                          href={`/oripas/${oripa.slug}`}
                          className="text-accent-400 underline"
                        >
                          {oripa.name}
                        </Link>
                      </h2>
                      <p className="mt-1">
                        <SaleStateBadge state={oripa.saleState} />
                      </p>
                    </div>
                  </div>

                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <dt className="text-base-100 text-xs">1 口価格</dt>
                      <dd className="font-bold tabular-nums">
                        {formatPoints(oripa.pricePoints)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-base-100 text-xs">残り口数</dt>
                      <dd className="font-bold tabular-nums">
                        {oripa.remainingSlots.toLocaleString('ja-JP')} /{' '}
                        {oripa.totalSlots.toLocaleString('ja-JP')}
                      </dd>
                    </div>
                  </dl>

                  <div>
                    <div
                      className="bg-base-800 h-2 w-full overflow-hidden rounded-full"
                      role="img"
                      aria-label={`販売進捗 ${soldRatio}%`}
                    >
                      <div
                        className="bg-accent-500 h-full"
                        style={{ width: `${soldRatio}%` }}
                      />
                    </div>
                    <p className="text-base-100 mt-1 text-xs">
                      販売期間:{' '}
                      <time dateTime={oripa.salesEndAt.toISOString()}>
                        {formatDateTimeJst(oripa.salesEndAt)}
                      </time>{' '}
                      まで
                    </p>
                  </div>
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
