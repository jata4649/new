import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { Alert } from '@/components/ui/alert.tsx'
import { Card, CardTitle } from '@/components/ui/card.tsx'
import { SaleStateBadge } from '@/components/ui/status-badge.tsx'
import { AppError } from '@/lib/api/errors.ts'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { formatPoints } from '@/lib/money/points.ts'
import { getPublicOripaDetail, type OripaDetail } from '@/modules/oripa/queries.ts'
import { getOptionalSession } from '@/server/guards.ts'

export const metadata: Metadata = { title: 'オリパ詳細' }
export const dynamic = 'force-dynamic'

/**
 * オリパ詳細。
 *
 * 確率・当たり残数はサーバーが計算した値をそのまま表示する。
 * クライアントに確率を計算させたり、抽選対象のスロットを指定させたりはしない。
 */
export default async function OripaDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const session = await getOptionalSession()

  let oripa: OripaDetail
  try {
    oripa = await getPublicOripaDetail(slug)
  } catch (error) {
    if (AppError.isAppError(error) && error.httpStatus === 404) {
      notFound()
    }
    throw error
  }

  const drawable = oripa.saleState === 'ON_SALE'

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">{oripa.name}</h1>
        <SaleStateBadge state={oripa.saleState} />
        <Link href="/oripas" className="text-accent-400 ml-auto text-sm underline">
          一覧へ戻る
        </Link>
      </div>

      {oripa.description ? (
        <p className="text-base-100 text-sm whitespace-pre-line">{oripa.description}</p>
      ) : null}

      {oripa.saleState === 'SUSPENDED' ? (
        <Alert tone="warning" title="このオリパは現在販売を停止しています">
          すでに確定した抽選結果は取り消されません。
        </Alert>
      ) : null}

      <Card className="space-y-3">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-base-100 text-xs">1 口価格</dt>
            <dd className="text-lg font-bold tabular-nums">
              {formatPoints(oripa.pricePoints)}
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">残り口数</dt>
            <dd className="text-lg font-bold tabular-nums">
              {oripa.remainingSlots.toLocaleString('ja-JP')} /{' '}
              {oripa.totalSlots.toLocaleString('ja-JP')}
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">1 人あたり上限</dt>
            <dd className="tabular-nums">
              {oripa.perUserLimit === null
                ? '上限なし'
                : `${oripa.perUserLimit.toLocaleString('ja-JP')} 口`}
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">販売終了</dt>
            <dd className="text-xs">
              <time dateTime={oripa.salesEndAt.toISOString()}>
                {formatDateTimeJst(oripa.salesEndAt)}
              </time>
            </dd>
          </div>
        </dl>

        {drawable ? (
          session ? (
            <div className="border-base-800 border-t pt-3">
              <Link
                href={`/oripas/${oripa.slug}/draw`}
                className="bg-accent-500 text-base-950 inline-block rounded-lg px-5 py-3 text-sm font-bold"
              >
                抽選する
              </Link>
            </div>
          ) : (
            <p className="border-base-800 border-t pt-3 text-sm">
              <Link
                href={`/login?callbackUrl=/oripas/${oripa.slug}/draw`}
                className="text-accent-400 underline"
              >
                ログイン
              </Link>
              すると抽選に参加できます。
            </p>
          )
        ) : null}
      </Card>

      <Card>
        <CardTitle>当選確率と残り本数</CardTitle>
        <p className="text-base-100/70 mt-1 text-xs">
          確率は「そのランクの口数 ÷ 総口数」です。有限プール方式のため、
          引かれた分だけ残り本数が減ります。
        </p>
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
                  本数
                </th>
                <th scope="col" className="py-2">
                  残り
                </th>
                <th scope="col" className="py-2">
                  交換ポイント（最大）
                </th>
              </tr>
            </thead>
            <tbody>
              {oripa.tiers.map((tier) => (
                <tr key={tier.code} className="border-base-800/50 border-b last:border-0">
                  <td className="py-2">
                    <span className="font-bold">{tier.name}</span>
                  </td>
                  <td className="py-2 tabular-nums">
                    {tier.oddsPercent}
                    <span className="text-base-100 ml-2 text-xs">{tier.oddsFraction}</span>
                  </td>
                  <td className="py-2 tabular-nums">
                    {tier.slotCount.toLocaleString('ja-JP')}
                  </td>
                  <td className="py-2 tabular-nums">
                    {tier.remainingCount.toLocaleString('ja-JP')}
                  </td>
                  <td className="py-2 tabular-nums">{formatPoints(tier.maxExchangePoints)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {oripa.topPrizes.length > 0 ? (
        <section aria-labelledby="prizes-heading">
          <h2 id="prizes-heading" className="text-lg font-bold">
            上位景品
          </h2>
          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {oripa.topPrizes.map((prize, index) => (
              <li key={`${prize.tierCode}-${index}`}>
                <Card className="h-full space-y-2 p-3">
                  {prize.imageKey ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 動的生成 SVG のため最適化不要
                    <img
                      src={`/api/placeholder/${encodeURIComponent(prize.imageKey)}`}
                      alt=""
                      width={120}
                      height={168}
                      className="w-full rounded-lg"
                    />
                  ) : null}
                  <p className="text-sm font-bold">{prize.name}</p>
                  <p className="text-base-100 text-xs">
                    {prize.tierCode} / {formatPoints(prize.exchangePoints)}
                  </p>
                  <p className="text-xs">
                    {prize.drawn ? (
                      <span className="text-base-100">獲得済み</span>
                    ) : (
                      <span className="text-emerald-300">残っています</span>
                    )}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {oripa.slotOrderCommit ? (
        <Card>
          <CardTitle>公正性の検証（コミット＆リビール）</CardTitle>
          <p className="text-base-100/70 mt-1 text-xs">
            公開時点で景品の並び順をハッシュ値として公表しています。販売終了後にシードを公開するので、
            「販売中に景品構成が差し替えられていないこと」を誰でも検証できます。
          </p>
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="text-base-100 text-xs">コミットハッシュ（SHA-256）</dt>
              <dd className="font-mono text-xs break-all">{oripa.slotOrderCommit}</dd>
            </div>
            <div>
              <dt className="text-base-100 text-xs">検証用シード</dt>
              <dd className="font-mono text-xs break-all">
                {oripa.revealedSeed ?? '販売終了後に公開します'}
              </dd>
            </div>
          </dl>
        </Card>
      ) : null}

      <Alert tone="info">
        クローズドテスト環境です。景品名・画像はすべて架空のサンプルであり、
        現金での購入・買取りは行いません。
      </Alert>
    </div>
  )
}
