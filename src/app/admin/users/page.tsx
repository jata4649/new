import type { Metadata } from 'next'
import Link from 'next/link'

import { Card } from '@/components/ui/card.tsx'
import { UserStatusBadge } from '@/components/ui/status-badge.tsx'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { formatPoints } from '@/lib/money/points.ts'
import { userListQuerySchema } from '@/modules/users/schema.ts'
import { listUsers } from '@/modules/users/service.ts'
import { requireAdmin } from '@/server/guards.ts'

export const metadata: Metadata = { title: 'ユーザー管理' }
export const dynamic = 'force-dynamic'

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin(PERMISSIONS.USER_READ)

  const raw = await searchParams
  // 画面からの入力も API と同じスキーマで検証する
  const parsed = userListQuerySchema.safeParse(raw)
  const query = parsed.success ? parsed.data : userListQuerySchema.parse({})

  const result = await listUsers(query)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">ユーザー管理</h1>

      <form method="get" className="flex flex-wrap gap-2">
        <label htmlFor="q" className="sr-only">
          メールアドレス・表示名で検索
        </label>
        <input
          id="q"
          name="q"
          defaultValue={query.q ?? ''}
          placeholder="メールアドレス・表示名で検索"
          className="border-base-700 bg-base-900 h-10 min-w-56 flex-1 rounded-lg border px-3 text-base"
        />
        <label htmlFor="status" className="sr-only">
          ステータス
        </label>
        <select
          id="status"
          name="status"
          defaultValue={query.status ?? ''}
          className="border-base-700 bg-base-900 h-10 rounded-lg border px-3 text-base"
        >
          <option value="">すべて</option>
          <option value="ACTIVE">利用中</option>
          <option value="SUSPENDED">停止中</option>
          <option value="WITHDRAWN">退会済み</option>
        </select>
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
                表示名
              </th>
              <th scope="col" className="px-4 py-2">
                メールアドレス
              </th>
              <th scope="col" className="px-4 py-2">
                ロール
              </th>
              <th scope="col" className="px-4 py-2">
                状態
              </th>
              <th scope="col" className="px-4 py-2">
                保有ポイント
              </th>
              <th scope="col" className="px-4 py-2">
                最終ログイン
              </th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((user) => (
              <tr key={user.id} className="border-base-800/50 border-b last:border-0">
                <td className="px-4 py-2">
                  <Link
                    href={`/admin/users/${user.id}`}
                    className="text-accent-400 font-bold underline"
                  >
                    {user.displayName ?? '(未設定)'}
                  </Link>
                </td>
                <td className="px-4 py-2 text-xs break-all">{user.email}</td>
                <td className="px-4 py-2 font-mono text-xs">{user.role}</td>
                <td className="px-4 py-2">
                  <UserStatusBadge status={user.status} />
                </td>
                <td className="px-4 py-2 tabular-nums">
                  {formatPoints(user.paidBalance + user.freeBalance)}
                </td>
                <td className="px-4 py-2 text-xs whitespace-nowrap">
                  {user.lastLoginAt ? (
                    <time dateTime={user.lastLoginAt.toISOString()}>
                      {formatDateTimeJst(user.lastLoginAt)}
                    </time>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
            {result.items.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-base-100 px-4 py-6 text-center">
                  該当するユーザーがいません。
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
              href={`/admin/users?page=${result.page - 1}`}
              className="border-base-700 rounded-lg border px-3 py-2 text-sm"
            >
              前へ
            </Link>
          ) : null}
          {result.page < result.totalPages ? (
            <Link
              href={`/admin/users?page=${result.page + 1}`}
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
