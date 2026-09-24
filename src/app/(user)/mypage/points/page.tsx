import type { Metadata } from 'next'
import Link from 'next/link'

import { Card, CardTitle } from '@/components/ui/card.tsx'
import { Alert } from '@/components/ui/alert.tsx'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { formatPoints } from '@/lib/money/points.ts'
import { getPointSummary } from '@/modules/points/queries.ts'
import { requireUser } from '@/server/guards.ts'

export const metadata: Metadata = { title: '保有ポイント' }
export const dynamic = 'force-dynamic'

/**
 * 保有ポイント。
 *
 * 表示するのは spendable（実際に使える残高）。
 * 口座キャッシュは失効バッチが走るまで期限切れ分を含むことがあるため使わない。
 */
export default async function PointsPage() {
  const session = await requireUser('/mypage/points')
  const summary = await getPointSummary(session.id)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">保有ポイント</h1>
        <Link href="/mypage/points/history" className="text-accent-400 text-sm underline">
          ポイント履歴
        </Link>
        <Link href="/mypage/points/purchase" className="text-accent-400 text-sm underline">
          テストポイントを取得
        </Link>
      </div>

      <Card>
        <CardTitle>利用可能なポイント</CardTitle>
        <p className="mt-2 text-3xl font-bold tabular-nums">
          {formatPoints(summary.spendable.total)}
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-base-100">有償ポイント</dt>
            <dd className="font-bold tabular-nums">{formatPoints(summary.spendable.paid)}</dd>
          </div>
          <div>
            <dt className="text-base-100">無償ポイント</dt>
            <dd className="font-bold tabular-nums">{formatPoints(summary.spendable.free)}</dd>
          </div>
        </dl>
      </Card>

      {summary.expiringSoon > 0 ? (
        <Alert tone="warning" title="まもなく失効するポイントがあります">
          30 日以内に {formatPoints(summary.expiringSoon)} が失効します。
        </Alert>
      ) : null}

      <section aria-labelledby="lots-heading">
        <h2 id="lots-heading" className="text-lg font-bold">
          有効期限の内訳
        </h2>
        <p className="text-base-100 mt-1 text-sm">
          有効期限が近いものから順に消費されます（無償ポイントを優先）。
        </p>

        <Card className="mt-3 overflow-x-auto p-0">
          {summary.lots.length === 0 ? (
            <p className="text-base-100 p-4 text-sm">利用可能なポイントがありません。</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-base-800 text-base-100 border-b text-xs">
                <tr>
                  <th scope="col" className="px-4 py-2">
                    種別
                  </th>
                  <th scope="col" className="px-4 py-2">
                    残り
                  </th>
                  <th scope="col" className="px-4 py-2">
                    有効期限
                  </th>
                  <th scope="col" className="px-4 py-2">
                    残日数
                  </th>
                </tr>
              </thead>
              <tbody>
                {summary.lots.map((lot) => (
                  <tr key={lot.id} className="border-base-800/50 border-b last:border-0">
                    <td className="px-4 py-2">{lot.pointType === 'PAID' ? '有償' : '無償'}</td>
                    <td className="px-4 py-2 tabular-nums">
                      {formatPoints(lot.amountRemaining)}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <time dateTime={lot.expiresAt.toISOString()}>
                        {formatDateTimeJst(lot.expiresAt)}
                      </time>
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {lot.daysUntilExpiry <= 30 ? (
                        <span className="font-bold text-amber-400">
                          あと {lot.daysUntilExpiry} 日
                        </span>
                      ) : (
                        `あと ${lot.daysUntilExpiry} 日`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </div>
  )
}
