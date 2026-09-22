import type { Metadata } from 'next'
import Link from 'next/link'

import { UserStatusForm } from '@/components/admin/user-status-form.tsx'
import { Card, CardTitle } from '@/components/ui/card.tsx'
import { UserStatusBadge } from '@/components/ui/status-badge.tsx'
import { hasPermission, PERMISSIONS } from '@/lib/auth/permissions.ts'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { formatPoints } from '@/lib/money/points.ts'
import { getUserDetail } from '@/modules/users/service.ts'
import { requireAdmin } from '@/server/guards.ts'

export const metadata: Metadata = { title: 'ユーザー詳細' }
export const dynamic = 'force-dynamic'

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await requireAdmin(PERMISSIONS.USER_READ)
  const { id } = await params
  const user = await getUserDetail(id)

  const canUpdateStatus = hasPermission(session.role, PERMISSIONS.USER_UPDATE_STATUS)
  const isSelf = user.id === session.id

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/users" className="text-accent-400 text-sm underline">
          ← ユーザー一覧へ戻る
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold">{user.displayName ?? '(表示名未設定)'}</h1>
          <UserStatusBadge status={user.status} />
          <span className="bg-base-800 rounded px-2 py-0.5 font-mono text-xs">{user.role}</span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardTitle>アカウント</CardTitle>
          <dl className="mt-2 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-base-100">メールアドレス</dt>
              <dd className="break-all">{user.email}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-base-100">メール確認</dt>
              <dd>{user.emailVerified ? '確認済み' : '未確認'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-base-100">登録日</dt>
              <dd>
                <time dateTime={user.createdAt.toISOString()}>
                  {formatDateTimeJst(user.createdAt)}
                </time>
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-base-100">最終ログイン</dt>
              <dd>
                {user.lastLoginAt ? formatDateTimeJst(user.lastLoginAt) : 'ログイン履歴なし'}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-base-100">有効なセッション</dt>
              <dd className="tabular-nums">{user.activeSessionCount} 件</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <CardTitle>保有ポイント</CardTitle>
          <p className="mt-2 text-2xl font-bold tabular-nums">
            {formatPoints(user.paidBalance + user.freeBalance)}
          </p>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-base-100">有償</dt>
              <dd className="tabular-nums">{formatPoints(user.paidBalance)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-base-100">無償</dt>
              <dd className="tabular-nums">{formatPoints(user.freeBalance)}</dd>
            </div>
          </dl>
          <p className="text-base-100/70 mt-3 text-xs">
            ポイント履歴の表示と調整は Phase 3 で追加します。
          </p>
        </Card>

        <Card>
          <CardTitle>利用状況</CardTitle>
          <dl className="mt-2 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-base-100">抽選回数</dt>
              <dd className="tabular-nums">{user.drawCount.toLocaleString('ja-JP')}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-base-100">当選商品</dt>
              <dd className="tabular-nums">{user.prizeCount.toLocaleString('ja-JP')}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-base-100">発送申請</dt>
              <dd className="tabular-nums">
                {user.shippingRequestCount.toLocaleString('ja-JP')}
              </dd>
            </div>
          </dl>
          <p className="text-base-100/70 mt-3 text-xs">
            履歴の一覧表示は Phase 5 以降で追加します。
          </p>
        </Card>

        {user.statusReason ? (
          <Card>
            <CardTitle>現在のステータス理由</CardTitle>
            <p className="mt-2 text-sm">{user.statusReason}</p>
            {user.statusChangedAt ? (
              <p className="text-base-100 mt-1 text-xs">
                変更日時:{' '}
                <time dateTime={user.statusChangedAt.toISOString()}>
                  {formatDateTimeJst(user.statusChangedAt)}
                </time>
              </p>
            ) : null}
          </Card>
        ) : null}
      </div>

      {canUpdateStatus ? (
        <section aria-labelledby="status-heading">
          <h2 id="status-heading" className="text-lg font-bold">
            ステータス変更
          </h2>
          <Card className="mt-3">
            {isSelf ? (
              <p className="text-base-100 text-sm">
                自分自身のステータスは変更できません（管理画面から締め出される事故を防ぐため）。
              </p>
            ) : (
              <UserStatusForm userId={user.id} currentStatus={user.status} />
            )}
          </Card>
        </section>
      ) : null}
    </div>
  )
}
