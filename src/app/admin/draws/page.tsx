import type { Metadata } from 'next'
import Link from 'next/link'

import { Card } from '@/components/ui/card.tsx'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { formatPoints } from '@/lib/money/points.ts'
import { listDrawsForAdmin } from '@/modules/draws/queries.ts'
import { adminDrawListQuerySchema } from '@/modules/draws/schema.ts'
import { requireAdmin } from '@/server/guards.ts'

export const metadata: Metadata = { title: '抽選履歴' }
export const dynamic = 'force-dynamic'

/**
 * 抽選履歴（管理画面）。
 *
 * 問い合わせ対応のための参照専用。取り消しや再抽選の機能は作らない。
 * 抽選は追記専用テーブルに記録されており、DB トリガが UPDATE / DELETE を拒否する。
 */
export default async function AdminDrawsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin(PERMISSIONS.DRAW_READ)

  const raw = await searchParams
  const parsed = adminDrawListQuerySchema.safeParse(raw)
  const query = parsed.success ? parsed.data : adminDrawListQuerySchema.parse({})

  const result = await listDrawsForAdmin(query)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">抽選履歴</h1>

      <p className="text-base-100 text-sm">
        参照専用です。抽選の取り消し・再抽選はできません（追記専用テーブルのため、 DB
        トリガが変更と削除を拒否します）。
      </p>

      <form method="get" className="flex flex-wrap gap-2">
        <label htmlFor="userEmail" className="sr-only">
          メールアドレスで絞り込み
        </label>
        <input
          id="userEmail"
          name="userEmail"
          defaultValue={query.userEmail ?? ''}
          placeholder="メールアドレスで絞り込み"
          className="border-base-700 bg-base-900 h-10 min-w-56 flex-1 rounded-lg border px-3 text-base"
        />
        <label htmlFor="campaignSlug" className="sr-only">
          オリパのスラッグ
        </label>
        <input
          id="campaignSlug"
          name="campaignSlug"
          defaultValue={query.campaignSlug ?? ''}
          placeholder="オリパのスラッグ"
          className="border-base-700 bg-base-900 h-10 min-w-48 rounded-lg border px-3 text-base"
        />
        <button
          type="submit"
          className="bg-accent-500 text-base-950 h-10 rounded-lg px-4 text-sm font-bold"
        >
          検索
        </button>
      </form>

      <p className="text-base-100 text-sm">
        {result.total.toLocaleString('ja-JP')} 件中 {result.items.length} 件を表示（
        {result.page} / {result.totalPages} ページ）
      </p>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-base-800 text-base-100 border-b text-xs">
            <tr>
              <th scope="col" className="px-4 py-2">
                日時
              </th>
              <th scope="col" className="px-4 py-2">
                ユーザー
              </th>
              <th scope="col" className="px-4 py-2">
                オリパ
              </th>
              <th scope="col" className="px-4 py-2">
                口数
              </th>
              <th scope="col" className="px-4 py-2">
                消費
              </th>
              <th scope="col" className="px-4 py-2">
                出たランク
              </th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((item) => (
              <tr key={item.id} className="border-base-800/50 border-b last:border-0">
                <td className="px-4 py-2 text-xs whitespace-nowrap">
                  <time dateTime={item.createdAt.toISOString()}>
                    {formatDateTimeJst(item.createdAt)}
                  </time>
                </td>
                <td className="px-4 py-2 text-xs break-all">
                  <Link
                    href={`/admin/users/${item.userId}`}
                    className="text-accent-400 underline"
                  >
                    {item.userEmail}
                  </Link>
                </td>
                <td className="px-4 py-2 text-xs">{item.campaignName}</td>
                <td className="px-4 py-2 tabular-nums">{item.drawCount}</td>
                <td className="px-4 py-2 tabular-nums">
                  {formatPoints(item.totalPricePoints)}
                </td>
                <td className="px-4 py-2 font-mono text-xs">{item.tierCodes.join(' ')}</td>
              </tr>
            ))}
            {result.items.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-base-100 px-4 py-6 text-center">
                  該当する抽選がありません。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>

      {result.totalPages > 1 ? (
        <nav aria-label="ページ送り" className="flex gap-2">
          {result.page > 1 ? (
            <Link
              href={`/admin/draws?page=${result.page - 1}`}
              className="border-base-700 rounded-lg border px-3 py-2 text-sm"
            >
              前へ
            </Link>
          ) : null}
          {result.page < result.totalPages ? (
            <Link
              href={`/admin/draws?page=${result.page + 1}`}
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
