import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { DrawPanel } from '@/components/draws/draw-panel.tsx'
import { Alert } from '@/components/ui/alert.tsx'
import { Card, CardTitle } from '@/components/ui/card.tsx'
import { SaleStateBadge } from '@/components/ui/status-badge.tsx'
import { AppError } from '@/lib/api/errors.ts'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { formatPoints } from '@/lib/money/points.ts'
import { getRemainingDrawQuota } from '@/modules/draws/queries.ts'
import { getPublicOripaDetail, type OripaDetail } from '@/modules/oripa/queries.ts'
import { getPointSummary } from '@/modules/points/queries.ts'
import { requireUser } from '@/server/guards.ts'

export const metadata: Metadata = { title: '抽選' }
export const dynamic = 'force-dynamic'

/**
 * 抽選画面。
 *
 * 表示している残高・残り口数・購入上限は、あくまで「この瞬間の参考値」。
 * 実際の可否判定は抽選トランザクションの中でサーバーが行う。
 * ここでボタンを無効化するのは利便性のためであり、認可でも整合性の保証でもない。
 */
export default async function DrawPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const session = await requireUser(`/oripas/${slug}/draw`)

  let oripa: OripaDetail
  try {
    oripa = await getPublicOripaDetail(slug)
  } catch (error) {
    if (AppError.isAppError(error) && error.httpStatus === 404) {
      notFound()
    }
    throw error
  }

  const [points, remainingQuota] = await Promise.all([
    getPointSummary(session.id),
    getRemainingDrawQuota(session.id, oripa.id, oripa.perUserLimit),
  ])

  const onSale = oripa.saleState === 'ON_SALE'

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">{oripa.name}</h1>
        <SaleStateBadge state={oripa.saleState} />
        <Link
          href={`/oripas/${oripa.slug}`}
          className="text-accent-400 ml-auto text-sm underline"
        >
          オリパの詳細へ
        </Link>
      </div>

      <Card>
        <CardTitle>抽選内容の確認</CardTitle>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-base-100 text-xs">1 口価格</dt>
            <dd className="text-lg font-bold tabular-nums">
              {formatPoints(oripa.pricePoints)}
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">利用可能ポイント</dt>
            <dd className="text-lg font-bold tabular-nums">
              {formatPoints(points.spendable.total)}
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">残り口数</dt>
            <dd className="tabular-nums">
              {oripa.remainingSlots.toLocaleString('ja-JP')} /{' '}
              {oripa.totalSlots.toLocaleString('ja-JP')}
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">あと引ける口数</dt>
            <dd className="tabular-nums">
              {remainingQuota === null
                ? '上限なし'
                : `${remainingQuota.toLocaleString('ja-JP')} 口`}
            </dd>
          </div>
        </dl>
        <p className="text-base-100/70 mt-3 text-xs">
          販売終了:{' '}
          <time dateTime={oripa.salesEndAt.toISOString()}>
            {formatDateTimeJst(oripa.salesEndAt)}
          </time>
        </p>
      </Card>

      {onSale ? (
        <Card>
          <CardTitle>口数を選ぶ</CardTitle>
          <div className="mt-4">
            <DrawPanel
              slug={oripa.slug}
              unitPricePoints={oripa.pricePoints}
              spendableBalance={points.spendable.total}
              remainingSlots={oripa.remainingSlots}
              remainingQuota={remainingQuota}
            />
          </div>
        </Card>
      ) : (
        <Alert tone="warning" title="現在このオリパは抽選できません">
          販売状態: <SaleStateBadge state={oripa.saleState} />
        </Alert>
      )}

      {points.spendable.total < oripa.pricePoints ? (
        <Alert tone="info">
          ポイントが不足しています。
          <Link href="/mypage/points/purchase" className="text-accent-400 ml-1 underline">
            テストポイントを取得
          </Link>
          できます。
        </Alert>
      ) : null}

      <Card>
        <CardTitle>当選確率</CardTitle>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-base-800 text-base-100 border-b text-xs">
              <tr>
                <th scope="col" className="py-2">
                  ランク
                </th>
                <th scope="col" className="py-2">
                  確率
                </th>
                <th scope="col" className="py-2">
                  残り
                </th>
              </tr>
            </thead>
            <tbody>
              {oripa.tiers.map((tier) => (
                <tr key={tier.code} className="border-base-800/50 border-b last:border-0">
                  <td className="py-2 font-bold">{tier.name}</td>
                  <td className="py-2 tabular-nums">
                    {tier.oddsPercent}
                    <span className="text-base-100 ml-2 text-xs">{tier.oddsFraction}</span>
                  </td>
                  <td className="py-2 tabular-nums">
                    {tier.remainingCount.toLocaleString('ja-JP')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Alert tone="info">
        クローズドテスト環境です。景品はすべて架空のサンプルで、
        現金での購入・買取りは行いません。演出は Phase 6 で追加します。
      </Alert>
    </div>
  )
}
