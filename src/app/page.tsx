import Link from 'next/link'

import { publicEnv } from '@/lib/config/env.ts'

/**
 * トップページ。
 * 公開中のオリパは /oripas で一覧できる（Phase 4）。
 * ここでは開発の進捗と、クローズドテストであることの明示に留める。
 */
export default function HomePage() {
  const phases = [
    { id: 1, title: '基盤・DB スキーマ・Docker', done: true },
    { id: 2, title: '認証・ユーザー・RBAC・管理画面基盤', done: true },
    { id: 3, title: 'ポイント台帳・ロット・Mock 決済', done: true },
    { id: 4, title: 'カード在庫・オリパ作成・抽選スロット生成', done: true },
    { id: 5, title: '1 回抽選・10 連抽選・冪等性・排他制御', done: true },
    { id: 6, title: '演出・抽選結果・商品一覧・ポイント交換', done: true },
    { id: 7, title: '配送先・発送申請・発送管理', done: true },
    { id: 8, title: '監査ログ・セキュリティ・テスト・ドキュメント', done: false },
  ]

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold">{publicEnv.NEXT_PUBLIC_SITE_NAME}</h1>
      <p className="text-base-100 mt-2 text-sm">
        クローズドテスト用の開発環境です。現金決済・現金買取り・一般公開は行いません。
        景品名と画像はすべて架空のサンプルです。
      </p>

      <p className="mt-6">
        <Link
          href="/oripas"
          className="bg-accent-500 text-base-950 inline-block rounded-lg px-5 py-3 text-sm font-bold"
        >
          オリパ一覧を見る
        </Link>
      </p>

      <section className="mt-8" aria-labelledby="phase-heading">
        <h2 id="phase-heading" className="text-lg font-semibold">
          開発フェーズ
        </h2>
        <ul className="mt-3 space-y-2">
          {phases.map((phase) => (
            <li
              key={phase.id}
              className="rounded-card bg-base-900 flex items-center gap-3 px-4 py-3"
            >
              <span
                aria-hidden="true"
                className={
                  phase.done
                    ? 'bg-accent-500 size-2.5 shrink-0 rounded-full'
                    : 'bg-base-700 size-2.5 shrink-0 rounded-full'
                }
              />
              <span className="text-sm">
                Phase {phase.id}: {phase.title}
              </span>
              <span className="text-base-100 ml-auto text-xs">
                {phase.done ? '完了' : '未着手'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
