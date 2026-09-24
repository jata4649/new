import type { Metadata } from 'next'

import { Card } from '@/components/ui/card.tsx'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { formatPoints } from '@/lib/money/points.ts'
import { getDashboardStats, getRecentAuditLogs } from '@/modules/users/dashboard.ts'
import { requireAdmin } from '@/server/guards.ts'

export const metadata: Metadata = { title: 'ダッシュボード' }
export const dynamic = 'force-dynamic'

export default async function AdminDashboardPage() {
  await requireAdmin(PERMISSIONS.USER_READ)

  const [stats, auditLogs] = await Promise.all([getDashboardStats(), getRecentAuditLogs(10)])

  const tiles = [
    { label: '登録ユーザー数', value: stats.userCount.toLocaleString('ja-JP') },
    { label: '停止中ユーザー', value: stats.suspendedUserCount.toLocaleString('ja-JP') },
    { label: '販売中オリパ', value: stats.activeCampaignCount.toLocaleString('ja-JP') },
    { label: '総抽選回数', value: stats.totalDrawCount.toLocaleString('ja-JP') },
    { label: '当日抽選回数', value: stats.todayDrawCount.toLocaleString('ja-JP') },
    { label: '発行ポイント', value: formatPoints(stats.issuedPoints) },
    { label: '消費ポイント', value: formatPoints(stats.consumedPoints) },
    { label: '未処理発送申請', value: stats.pendingShippingCount.toLocaleString('ja-JP') },
    {
      label: '在庫数（利用可能）',
      value: stats.availableInventoryCount.toLocaleString('ja-JP'),
    },
  ]

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">ダッシュボード</h1>

      <section aria-labelledby="stats-heading">
        <h2 id="stats-heading" className="sr-only">
          集計
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {tiles.map((tile) => (
            <Card key={tile.label}>
              <p className="text-base-100 text-xs">{tile.label}</p>
              <p className="mt-1 text-xl font-bold tabular-nums">{tile.value}</p>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="audit-heading">
        <h2 id="audit-heading" className="text-lg font-bold">
          直近の操作履歴
        </h2>
        <Card className="mt-3 overflow-x-auto p-0">
          {auditLogs.length === 0 ? (
            <p className="text-base-100 p-4 text-sm">記録がありません。</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-base-800 text-base-100 border-b text-xs">
                <tr>
                  <th scope="col" className="px-4 py-2">
                    日時
                  </th>
                  <th scope="col" className="px-4 py-2">
                    操作
                  </th>
                  <th scope="col" className="px-4 py-2">
                    対象
                  </th>
                  <th scope="col" className="px-4 py-2">
                    理由
                  </th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((log) => (
                  <tr key={log.id} className="border-base-800/50 border-b last:border-0">
                    <td className="px-4 py-2 whitespace-nowrap">
                      <time dateTime={log.createdAt.toISOString()}>
                        {formatDateTimeJst(log.createdAt)}
                      </time>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{log.action}</td>
                    <td className="text-base-100 px-4 py-2 text-xs">{log.targetType ?? '—'}</td>
                    <td className="text-base-100 px-4 py-2 text-xs">{log.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>

      <p className="text-base-100/70 text-xs">
        直近のエラー表示は Sentry 接続（Phase 8）で追加します。
      </p>
    </div>
  )
}
