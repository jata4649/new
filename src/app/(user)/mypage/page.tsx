import type { Metadata } from 'next'

import { Card, CardTitle } from '@/components/ui/card.tsx'
import { UserStatusBadge } from '@/components/ui/status-badge.tsx'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { formatPoints } from '@/lib/money/points.ts'
import { getMyProfile } from '@/modules/users/me.ts'
import { requireUser } from '@/server/guards.ts'

export const metadata: Metadata = { title: 'マイページ' }
export const dynamic = 'force-dynamic'

/**
 * マイページ。
 *
 * Phase 2 では残高と基本情報のみ。
 * ポイント履歴（Phase 3）・抽選履歴（Phase 5）・当選商品（Phase 6）・
 * 発送申請（Phase 7）は各フェーズで追加する。
 */
export default async function MyPage() {
  const session = await requireUser('/mypage')
  const profile = await getMyProfile(session.id)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold">マイページ</h1>
        <UserStatusBadge status={profile.status} />
      </div>

      <Card>
        <CardTitle>保有ポイント</CardTitle>
        <p className="mt-2 text-3xl font-bold tabular-nums">
          {formatPoints(profile.points.total)}
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-base-100">有償ポイント</dt>
            <dd className="font-bold tabular-nums">{formatPoints(profile.points.paid)}</dd>
          </div>
          <div>
            <dt className="text-base-100">無償ポイント</dt>
            <dd className="font-bold tabular-nums">{formatPoints(profile.points.free)}</dd>
          </div>
        </dl>
        <p className="text-base-100/70 mt-3 text-xs">
          ポイントの購入（テスト決済）と履歴表示は Phase 3 で追加します。
        </p>
      </Card>

      <Card>
        <CardTitle>アカウント情報</CardTitle>
        <dl className="mt-2 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-base-100">表示名</dt>
            <dd>{profile.displayName ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-base-100">メールアドレス</dt>
            <dd className="break-all">{profile.email}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-base-100">登録日</dt>
            <dd>
              <time dateTime={profile.createdAt.toISOString()}>
                {formatDateTimeJst(profile.createdAt)}
              </time>
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  )
}
