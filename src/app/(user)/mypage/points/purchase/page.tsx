import type { Metadata } from 'next'
import Link from 'next/link'

import { TestPaymentPanel } from '@/components/points/test-payment-panel.tsx'
import { Card } from '@/components/ui/card.tsx'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { getPaymentHistory } from '@/modules/points/queries.ts'
import { requireUser } from '@/server/guards.ts'

export const metadata: Metadata = { title: 'テストポイントの取得' }
export const dynamic = 'force-dynamic'

const STATUS_LABELS: Record<string, string> = {
  PENDING: '処理中',
  SUCCEEDED: '成功',
  FAILED: '失敗',
  CANCELLED: '取消し',
  REFUNDED: '返金済み',
}

export default async function PurchasePointsPage() {
  const session = await requireUser('/mypage/points/purchase')
  const payments = await getPaymentHistory(session.id)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">テストポイントの取得</h1>
        <Link href="/mypage/points" className="text-accent-400 text-sm underline">
          保有ポイントへ戻る
        </Link>
      </div>

      <TestPaymentPanel />

      <section aria-labelledby="payment-history-heading">
        <h2 id="payment-history-heading" className="text-lg font-bold">
          テスト決済の履歴
        </h2>
        <Card className="mt-3 overflow-x-auto p-0">
          {payments.length === 0 ? (
            <p className="text-base-100 p-4 text-sm">履歴がありません。</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-base-800 text-base-100 border-b text-xs">
                <tr>
                  <th scope="col" className="px-4 py-2">
                    日時
                  </th>
                  <th scope="col" className="px-4 py-2 text-right">
                    金額
                  </th>
                  <th scope="col" className="px-4 py-2 text-right">
                    付与ポイント
                  </th>
                  <th scope="col" className="px-4 py-2">
                    状態
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id} className="border-base-800/50 border-b last:border-0">
                    <td className="px-4 py-2 whitespace-nowrap">
                      <time dateTime={payment.createdAt.toISOString()}>
                        {formatDateTimeJst(payment.createdAt)}
                      </time>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {payment.amountYen.toLocaleString('ja-JP')} 円
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {payment.status === 'SUCCEEDED'
                        ? `${payment.grantPoints.toLocaleString('ja-JP')} P`
                        : '—'}
                    </td>
                    <td className="px-4 py-2">
                      {STATUS_LABELS[payment.status] ?? payment.status}
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
