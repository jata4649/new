import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { OripaAllocationForm } from '@/components/admin/oripa-allocation-form.tsx'
import { OripaPublishControls } from '@/components/admin/oripa-publish-controls.tsx'
import { OripaRevealButton } from '@/components/admin/oripa-reveal-button.tsx'
import { Alert } from '@/components/ui/alert.tsx'
import { Card, CardTitle } from '@/components/ui/card.tsx'
import { CampaignStatusBadge } from '@/components/ui/status-badge.tsx'
import { AppError } from '@/lib/api/errors.ts'
import { hasPermission, PERMISSIONS } from '@/lib/auth/permissions.ts'
import { formatDateTimeJst, isAfter, now } from '@/lib/datetime/index.ts'
import { formatOdds, formatPercent, formatPoints, ratio } from '@/lib/money/points.ts'
import {
  getOripaDetailForAdmin,
  listAllocatedInventoryIdsByTier,
  listAllocationCandidates,
  listGenericPrizes,
  type AdminOripaDetail,
} from '@/modules/oripa/service.ts'
import { requireAdmin } from '@/server/guards.ts'

export const metadata: Metadata = { title: 'オリパの詳細' }
export const dynamic = 'force-dynamic'

export default async function AdminOripaDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await requireAdmin(PERMISSIONS.ORIPA_READ)
  const { id } = await params

  let campaign: AdminOripaDetail
  try {
    campaign = await getOripaDetailForAdmin(id)
  } catch (error) {
    if (AppError.isAppError(error) && error.httpStatus === 404) {
      notFound()
    }
    throw error
  }

  const canWrite = hasPermission(session.role, PERMISSIONS.ORIPA_WRITE)
  const canPublish = hasPermission(session.role, PERMISSIONS.ORIPA_PUBLISH)
  const canSuspend = hasPermission(session.role, PERMISSIONS.ORIPA_SUSPEND)
  const isDraft = campaign.status === 'DRAFT' && campaign.publishedAt === null

  /*
   * シードを公開できるのは販売が終わってから。
   * 販売中に公開すると、シードから抽選順を再現して
   * 「次に何が出るか」を計算できてしまう。
   * ここでの判定は導線の出し分けで、拒否の正はサーバー側にある。
   */
  const salesEnded =
    campaign.status === 'SOLD_OUT' ||
    campaign.status === 'ENDED' ||
    campaign.status === 'ARCHIVED' ||
    !isAfter(campaign.salesEndAt, now())

  const [candidates, allocatedByTier, genericPrizes] = isDraft
    ? await Promise.all([
        listAllocationCandidates(campaign.id),
        listAllocatedInventoryIdsByTier(campaign.id),
        listGenericPrizes(),
      ])
    : [[], new Map<string, string[]>(), []]

  /*
   * 期待値は「交換ポイント合計 ÷ 総口数」、つまり 1 口あたりの期待交換ポイント。
   * これはポイントであって割合ではないので、百分率として出してはいけない
   * （8,290 P / 口 を百分率にすると 829,059% という無意味な数字になる）。
   *
   * 割合として意味があるのは 1 口価格に対する還元率のほう。
   * 分母へ価格を掛けるだけで求まるので、整数比のまま保てる。
   */
  const expectedPointsNumerator = campaign.publishCheck.summary.expectedValueNumerator
  const expectedPointsDenominator = Math.max(
    1,
    campaign.publishCheck.summary.expectedValueDenominator,
  )
  const expectedPointsPerSlot = Math.floor(expectedPointsNumerator / expectedPointsDenominator)
  const returnRate = ratio(
    expectedPointsNumerator,
    expectedPointsDenominator * Math.max(1, campaign.pricePoints),
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">{campaign.name}</h1>
        <CampaignStatusBadge status={campaign.status} />
        <Link href="/admin/oripas" className="text-accent-400 ml-auto text-sm underline">
          オリパ一覧へ戻る
        </Link>
      </div>

      {campaign.status === 'SUSPENDED' && campaign.suspendReason ? (
        <Alert tone="warning" title="販売を停止中です">
          理由: {campaign.suspendReason}
          {campaign.suspendedAt ? `（${formatDateTimeJst(campaign.suspendedAt)}）` : null}
        </Alert>
      ) : null}

      <Card>
        <CardTitle>基本情報</CardTitle>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-base-100 text-xs">スラッグ</dt>
            <dd className="font-mono">{campaign.slug}</dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">1 口価格</dt>
            <dd className="tabular-nums">{formatPoints(campaign.pricePoints)}</dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">残り / 総口数</dt>
            <dd className="tabular-nums">
              {campaign.remainingSlots.toLocaleString('ja-JP')} /{' '}
              {campaign.totalSlots.toLocaleString('ja-JP')}
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">1 人あたり上限</dt>
            <dd className="tabular-nums">
              {campaign.perUserLimit === null
                ? '上限なし'
                : `${campaign.perUserLimit.toLocaleString('ja-JP')} 口`}
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">販売期間</dt>
            <dd className="text-xs">
              <time dateTime={campaign.salesStartAt.toISOString()}>
                {formatDateTimeJst(campaign.salesStartAt)}
              </time>
              {' 〜 '}
              <time dateTime={campaign.salesEndAt.toISOString()}>
                {formatDateTimeJst(campaign.salesEndAt)}
              </time>
            </dd>
          </div>
          <div>
            <dt className="text-base-100 text-xs">公開日時</dt>
            <dd className="text-xs">
              {campaign.publishedAt ? formatDateTimeJst(campaign.publishedAt) : '未公開'}
            </dd>
          </div>
        </dl>
      </Card>

      <Card>
        <CardTitle>景品ランクと当選確率</CardTitle>
        <p className="text-base-100/70 mt-1 text-xs">
          確率は「ランクの口数 ÷ 総口数」です。確率を個別に設定する項目はありません。
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-base-800 text-base-100 border-b text-xs">
              <tr>
                <th scope="col" className="py-2">
                  ランク
                </th>
                <th scope="col" className="py-2">
                  演出
                </th>
                <th scope="col" className="py-2">
                  口数
                </th>
                <th scope="col" className="py-2">
                  確率
                </th>
                <th scope="col" className="py-2">
                  生成済み
                </th>
                <th scope="col" className="py-2">
                  残り
                </th>
                <th scope="col" className="py-2">
                  うち実在庫
                </th>
              </tr>
            </thead>
            <tbody>
              {campaign.tiers.map((tier) => {
                const odds = ratio(tier.slotCount, campaign.totalSlots)
                return (
                  <tr key={tier.id} className="border-base-800/50 border-b last:border-0">
                    <td className="py-2">
                      <span className="font-bold">{tier.name}</span>
                      <span className="text-base-100 ml-2 font-mono text-xs">{tier.code}</span>
                    </td>
                    <td className="py-2 font-mono text-xs">{tier.effectTier}</td>
                    <td className="py-2 tabular-nums">
                      {tier.slotCount.toLocaleString('ja-JP')}
                    </td>
                    <td className="py-2 tabular-nums">
                      {formatPercent(odds)}
                      <span className="text-base-100 ml-2 text-xs">{formatOdds(odds)}</span>
                    </td>
                    <td className="py-2 tabular-nums">
                      {tier.generatedCount.toLocaleString('ja-JP')}
                    </td>
                    <td className="py-2 tabular-nums">
                      {tier.remainingCount.toLocaleString('ja-JP')}
                    </td>
                    <td className="py-2 tabular-nums">
                      {tier.inventoryCount.toLocaleString('ja-JP')}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-base-100 mt-3 text-sm">
          期待値（交換ポイント合計 ÷ 総口数）:{' '}
          <span className="tabular-nums">
            {expectedPointsPerSlot.toLocaleString('ja-JP')} P / 口
          </span>
          （1 口 {formatPoints(campaign.pricePoints)} に対する還元率{' '}
          <span className="tabular-nums">{formatPercent(returnRate, 1)}</span>）
        </p>
      </Card>

      <Card>
        <CardTitle>{isDraft ? '公開条件' : '販売の操作'}</CardTitle>
        {/*
          公開条件のチェックリストは下書きのときだけ意味がある。
          公開済みのオリパへ出すと「公開できるのは下書きのときだけです」が
          未達条件として並び、あたかも問題があるように読めてしまう。
        */}
        {!isDraft ? (
          <Alert tone="info" className="mt-3">
            公開済みです。公開条件の確認は下書きのときだけ行います。
          </Alert>
        ) : campaign.publishCheck.publishable ? (
          <Alert tone="success" className="mt-3">
            すべての公開条件を満たしています。
          </Alert>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {campaign.publishCheck.problems.map((problem) => (
              <li
                key={`${problem.field}-${problem.message}`}
                className="flex items-start gap-2"
              >
                <span
                  aria-hidden="true"
                  className="mt-1 size-2 shrink-0 rounded-full bg-amber-400"
                />
                <span>
                  <span className="text-base-100 font-mono text-xs">{problem.field}</span>
                  <span className="ml-2">{problem.message}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4">
          <OripaPublishControls
            campaignId={campaign.id}
            status={campaign.status}
            publishable={campaign.publishCheck.publishable}
            canPublish={canPublish}
            canSuspend={canSuspend}
          />
        </div>
      </Card>

      {campaign.slotOrderCommit ? (
        <Card>
          <CardTitle>公正性の記録（コミット＆リビール）</CardTitle>
          <p className="text-base-100/70 mt-1 text-xs">
            公開時にスロットの並び順をハッシュで封じています。販売終了後にシードを公開すると、
            第三者が「景品構成が差し替えられていないこと」を検証できます。 シードはこの画面にも
            API にも表示しません。
          </p>
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="text-base-100 text-xs">コミットハッシュ（SHA-256）</dt>
              <dd className="font-mono text-xs break-all">{campaign.slotOrderCommit}</dd>
            </div>
            <div>
              <dt className="text-base-100 text-xs">シードの公開</dt>
              <dd>
                {campaign.slotOrderRevealedAt
                  ? formatDateTimeJst(campaign.slotOrderRevealedAt)
                  : '未公開（販売終了後に公開します）'}
              </dd>
            </div>
          </dl>

          {canPublish ? (
            <OripaRevealButton
              campaignId={campaign.id}
              canReveal={campaign.slotOrderRevealedAt === null && salesEnded}
              blockedReason={
                campaign.slotOrderRevealedAt !== null
                  ? 'シードは公開済みです。公開日時は変更できません。'
                  : '販売中はシードを公開できません（次に出るものを計算できてしまうため）。'
              }
            />
          ) : null}
        </Card>
      ) : null}

      {isDraft && canWrite ? (
        <Card>
          <CardTitle>景品の割当とスロット生成</CardTitle>
          <p className="text-base-100/70 mt-1 text-xs">
            抽選順はサーバー側で暗号論的乱数によりシャッフルされ、画面にも API にも出しません。
          </p>
          <div className="mt-4">
            <OripaAllocationForm
              campaignId={campaign.id}
              tiers={campaign.tiers.map((tier) => ({
                code: tier.code,
                name: tier.name,
                slotCount: tier.slotCount,
                allocatedInventoryIds: allocatedByTier.get(tier.code) ?? [],
              }))}
              inventories={candidates}
              genericPrizes={genericPrizes.map((prize) => ({
                code: prize.code,
                name: prize.name,
                exchangePoints: prize.exchangePoints,
              }))}
            />
          </div>
        </Card>
      ) : null}

      {!isDraft ? (
        <Alert tone="info">
          公開済みのため、価格・総口数・景品構成は変更できません。 アプリケーションと DB
          トリガの両方で拒否されます。
        </Alert>
      ) : null}
    </div>
  )
}
