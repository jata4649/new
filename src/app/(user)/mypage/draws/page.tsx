import type { Metadata } from 'next'
import Link from 'next/link'

import { Card } from '@/components/ui/card.tsx'
import { EffectTierBadge } from '@/components/ui/status-badge.tsx'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { formatPoints } from '@/lib/money/points.ts'
import { listUserDraws } from '@/modules/draws/queries.ts'
import { drawHistoryQuerySchema } from '@/modules/draws/schema.ts'
import { requireUser } from '@/server/guards.ts'

export const metadata: Metadata = { title: '抽選履歴' }
export const dynamic = 'force-dynamic'

/**
 * 抽選履歴。
 *
 * 「通信が切れて結果が見えなかった」場合の復帰経路でもある。
 * 抽選はサーバー側で確定しているので、ここに出ていれば成立している。
 */
export default async function DrawHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireUser('/mypage/draws')

  const raw = await searchParams
  const parsed = drawHistoryQuerySchema.safeParse(raw)
  const query = parsed.success ? parsed.data : drawHistoryQuerySchema.parse({})

  const result = await listUserDraws(session.id, query)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">抽選履歴</h1>
        <Link href="/oripas" className="text-accent-400 text-sm underline">
          オリパ一覧
        </Link>
      </div>

      {result.items.length === 0 ? (
        <Card>
          <p className="text-base-100 text-sm">まだ抽選していません。</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {result.items.map((item) => (
            <li key={item.id}>
              <Card className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/draws/${item.id}`}
                    className="text-accent-400 font-bold underline"
                  >
                    {item.campaignName}
                  </Link>
                  {item.topEffectTier ? (
                    <EffectTierBadge
                      tier={item.topEffectTier}
                      label={`最高 ${item.topEffectTier}`}
                    />
                  ) : null}
                </div>
                <dl className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className="text-base-100 text-xs">口数</dt>
                    <dd className="tabular-nums">{item.drawCount} 口</dd>
                  </div>
                  <div>
                    <dt className="text-base-100 text-xs">消費</dt>
                    <dd className="tabular-nums">{formatPoints(item.totalPricePoints)}</dd>
                  </div>
                  <div>
                    <dt className="text-base-100 text-xs">未選択の商品</dt>
                    <dd className="tabular-nums">{item.undecidedCount} 件</dd>
                  </div>
                </dl>
                <p className="text-base-100 text-xs">
                  <time dateTime={item.createdAt.toISOString()}>
                    {formatDateTimeJst(item.createdAt)}
                  </time>
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {result.totalPages > 1 ? (
        <nav aria-label="ページ送り" className="flex gap-2">
          {result.page > 1 ? (
            <Link
              href={`/mypage/draws?page=${result.page - 1}`}
              className="border-base-700 rounded-lg border px-3 py-2 text-sm"
            >
              前へ
            </Link>
          ) : null}
          {result.page < result.totalPages ? (
            <Link
              href={`/mypage/draws?page=${result.page + 1}`}
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
