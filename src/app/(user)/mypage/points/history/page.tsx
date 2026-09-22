import type { Metadata } from 'next'
import Link from 'next/link'

import { Card } from '@/components/ui/card.tsx'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { pointHistoryQuerySchema } from '@/modules/payments/schema.ts'
import { getPointHistory } from '@/modules/points/queries.ts'
import { requireUser } from '@/server/guards.ts'

export const metadata: Metadata = { title: 'ポイント履歴' }
export const dynamic = 'force-dynamic'

/** 取引種別の日本語表示。台帳の値をそのまま出さない。 */
const TX_TYPE_LABELS: Record<string, string> = {
  PURCHASE: '購入',
  DRAW: '抽選',
  PRIZE_EXCHANGE: '商品交換',
  BONUS: 'ボーナス',
  ADJUSTMENT: '調整',
  EXPIRE: '有効期限切れ',
  REFUND: '返金',
  REVERSAL: '取消し',
}

export default async function PointHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireUser('/mypage/points/history')

  const raw = await searchParams
  const parsed = pointHistoryQuerySchema.safeParse(raw)
  const query = parsed.success ? parsed.data : pointHistoryQuerySchema.parse({})

  const history = await getPointHistory(session.id, query)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">ポイント履歴</h1>
        <Link href="/mypage/points" className="text-accent-400 text-sm underline">
          保有ポイントへ戻る
        </Link>
      </div>

      <p className="text-base-100 text-sm">
        {history.total.toLocaleString('ja-JP')} 件（{history.page} / {history.totalPages}{' '}
        ページ）
      </p>

      <Card className="overflow-x-auto p-0">
        {history.items.length === 0 ? (
          <p className="text-base-100 p-4 text-sm">履歴がありません。</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-base-800 text-base-100 border-b text-xs">
              <tr>
                <th scope="col" className="px-4 py-2">
                  日時
                </th>
                <th scope="col" className="px-4 py-2">
                  種別
                </th>
                <th scope="col" className="px-4 py-2 text-right">
                  増減
                </th>
                <th scope="col" className="px-4 py-2 text-right">
                  残高
                </th>
                <th scope="col" className="px-4 py-2">
                  理由
                </th>
              </tr>
            </thead>
            <tbody>
              {history.items.map((entry) => (
                <tr key={entry.id} className="border-base-800/50 border-b last:border-0">
                  <td className="px-4 py-2 whitespace-nowrap">
                    <time dateTime={entry.createdAt.toISOString()}>
                      {formatDateTimeJst(entry.createdAt)}
                    </time>
                  </td>
                  <td className="px-4 py-2">{TX_TYPE_LABELS[entry.txType] ?? entry.txType}</td>
                  <td
                    className={
                      entry.amount >= 0
                        ? 'px-4 py-2 text-right font-bold text-emerald-400 tabular-nums'
                        : 'px-4 py-2 text-right font-bold text-red-400 tabular-nums'
                    }
                  >
                    {entry.amount >= 0 ? '+' : ''}
                    {entry.amount.toLocaleString('ja-JP')}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {entry.balanceAfter.toLocaleString('ja-JP')}
                  </td>
                  <td className="text-base-100 px-4 py-2 text-xs">{entry.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {history.totalPages > 1 ? (
        <nav aria-label="ページ送り" className="flex gap-2">
          {history.page > 1 ? (
            <Link
              href={`/mypage/points/history?page=${history.page - 1}`}
              className="border-base-700 rounded-lg border px-3 py-2 text-sm"
            >
              前へ
            </Link>
          ) : null}
          {history.page < history.totalPages ? (
            <Link
              href={`/mypage/points/history?page=${history.page + 1}`}
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
