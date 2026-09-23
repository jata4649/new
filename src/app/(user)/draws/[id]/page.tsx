import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PrizeThumb } from '@/components/prizes/prize-thumb.tsx'
import { Alert } from '@/components/ui/alert.tsx'
import { Card } from '@/components/ui/card.tsx'
import { EffectTierBadge } from '@/components/ui/status-badge.tsx'
import { AppError } from '@/lib/api/errors.ts'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { formatPoints } from '@/lib/money/points.ts'
import { getDrawDetail, type DrawDetail } from '@/modules/draws/queries.ts'
import { requireUser } from '@/server/guards.ts'

export const metadata: Metadata = { title: '抽選結果' }
export const dynamic = 'force-dynamic'

/**
 * 抽選結果。
 *
 * 演出（Phase 6）とは独立した静的な画面。
 * 演出を飛ばしても、途中で閉じても、リロードしても、この画面で結果を確認できる。
 * 結果は抽選時に DB へ確定しているので、ここは読み出すだけ。
 */
export default async function DrawResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await requireUser(`/draws/${id}`)

  let draw: DrawDetail
  try {
    draw = await getDrawDetail(id, session.id)
  } catch (error) {
    // 他人の抽選結果も「存在しない」として扱う（ID の存在を推測させない）
    if (AppError.isAppError(error) && error.httpStatus === 404) {
      notFound()
    }
    throw error
  }

  const totalExchangePoints = draw.results.reduce(
    (sum, result) => sum + result.exchangePoints,
    0,
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">抽選結果</h1>
        <Link href="/mypage/draws" className="text-accent-400 ml-auto text-sm underline">
          抽選履歴
        </Link>
      </div>

      <Card>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="col-span-2">
            <dt className="text-base-100 text-xs">オリパ</dt>
            <dd className="font-bold">
              <Link href={`/oripas/${draw.campaignSlug}`} className="text-accent-400 underline">
                {draw.campaignName}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">口数</dt>
            <dd className="tabular-nums">{draw.drawCount} 口</dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">消費ポイント</dt>
            <dd className="tabular-nums">{formatPoints(draw.totalPricePoints)}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-base-100 text-xs">抽選日時</dt>
            <dd className="text-xs">
              <time dateTime={draw.createdAt.toISOString()}>
                {formatDateTimeJst(draw.createdAt)}
              </time>
            </dd>
          </div>
        </dl>
      </Card>

      <section aria-labelledby="results-heading">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 id="results-heading" className="text-lg font-bold">
            当選した景品
          </h2>
          <p className="text-base-100 text-sm">
            交換ポイント合計:{' '}
            <span className="tabular-nums">{formatPoints(totalExchangePoints)}</span>
          </p>
        </div>

        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {draw.results.map((result) => (
            <li key={result.sequence}>
              <Card className="h-full space-y-2 p-3">
                <PrizeThumb
                  imageKey={result.imageKey}
                  effectTier={result.effectTier}
                  tierName={result.tierName}
                />
                <EffectTierBadge tier={result.effectTier} label={result.tierName} />
                <p className="text-sm font-bold">{result.name}</p>
                {result.rarity ? (
                  <p className="text-base-100 text-xs">{result.rarity}</p>
                ) : null}
                <p className="text-xs tabular-nums">
                  交換: {formatPoints(result.exchangePoints)}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <Alert tone="info" title="この先の操作">
        当選した景品は{' '}
        <Link href="/mypage/prizes" className="text-accent-400 underline">
          当選商品
        </Link>{' '}
        からポイント交換できます。発送申請は Phase 7 で追加します。
        選ぶまでは未選択（UNDECIDED）のまま保持されます。
      </Alert>
    </div>
  )
}
