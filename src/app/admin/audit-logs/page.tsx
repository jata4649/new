import type { Metadata } from 'next'
import Link from 'next/link'

import { Alert } from '@/components/ui/alert.tsx'
import { Card } from '@/components/ui/card.tsx'
import { PERMISSIONS } from '@/lib/auth/permissions.ts'
import { formatDateTimeJst } from '@/lib/datetime/index.ts'
import { listAuditLogs, listRecordedActions } from '@/modules/audit/queries.ts'
import { auditLogListQuerySchema } from '@/modules/audit/schema.ts'
import { requireAdmin } from '@/server/guards.ts'

export const metadata: Metadata = { title: '監査ログ' }
export const dynamic = 'force-dynamic'

/**
 * 監査ログ（管理画面）。
 *
 * 参照専用。この画面から記録を消すことも書き換えることもできない。
 * 「消せる監査ログ」は監査の用をなさないため、
 * アプリに経路を作らないだけでなく DB トリガでも拒否している。
 *
 * before / after は書き込み時に redact() を通してあるので、
 * パスワードハッシュやトークンはこの時点で既に伏せ字になっている。
 */
export default async function AdminAuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin(PERMISSIONS.AUDIT_READ)

  const raw = await searchParams
  const parsed = auditLogListQuerySchema.safeParse(raw)
  const query = parsed.success ? parsed.data : auditLogListQuerySchema.parse({})

  const [result, actions] = await Promise.all([listAuditLogs(query), listRecordedActions()])

  function pageHref(page: number): string {
    const params = new URLSearchParams()
    if (query.action) params.set('action', query.action)
    if (query.actorType) params.set('actorType', query.actorType)
    if (query.actorId) params.set('actorId', query.actorId)
    if (query.targetType) params.set('targetType', query.targetType)
    if (query.targetId) params.set('targetId', query.targetId)
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
    params.set('page', String(page))
    return `/admin/audit-logs?${params.toString()}`
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">監査ログ</h1>

      <Alert tone="info">
        参照専用です。この画面からログを書き換えることも削除することもできません
        （追記専用テーブルのため、DB トリガが変更と削除を拒否します）。
      </Alert>

      {!parsed.success ? (
        <Alert tone="error">検索条件が不正です。既定の条件で表示しています。</Alert>
      ) : null}

      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor="action" className="text-base-100 block text-xs">
            操作
          </label>
          <select
            id="action"
            name="action"
            defaultValue={query.action ?? ''}
            className="border-base-700 bg-base-900 h-10 rounded-lg border px-3 text-base"
          >
            <option value="">すべて</option>
            {actions.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="actorType" className="text-base-100 block text-xs">
            実行者
          </label>
          <select
            id="actorType"
            name="actorType"
            defaultValue={query.actorType ?? ''}
            className="border-base-700 bg-base-900 h-10 rounded-lg border px-3 text-base"
          >
            <option value="">すべて</option>
            <option value="ADMIN">管理者</option>
            <option value="USER">利用者</option>
            <option value="SYSTEM">システム</option>
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="targetId" className="text-base-100 block text-xs">
            対象 ID
          </label>
          <input
            id="targetId"
            name="targetId"
            defaultValue={query.targetId ?? ''}
            className="border-base-700 bg-base-900 h-10 rounded-lg border px-3 text-base"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="from" className="text-base-100 block text-xs">
            開始日
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={query.from ?? ''}
            className="border-base-700 bg-base-900 h-10 rounded-lg border px-3 text-base"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="to" className="text-base-100 block text-xs">
            終了日
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={query.to ?? ''}
            className="border-base-700 bg-base-900 h-10 rounded-lg border px-3 text-base"
          />
        </div>

        <button
          type="submit"
          className="bg-accent-500 text-base-950 h-10 rounded-lg px-4 text-sm font-bold"
        >
          絞り込む
        </button>
        <Link
          href="/admin/audit-logs"
          className="border-base-700 flex h-10 items-center rounded-lg border px-4 text-sm"
        >
          条件をクリア
        </Link>
      </form>

      <p className="text-base-100 text-sm tabular-nums">
        {result.total.toLocaleString('ja-JP')} 件中 {result.items.length} 件を表示
      </p>

      {result.items.length === 0 ? (
        <Card>
          <p className="text-base-100 text-sm">該当する記録がありません。</p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {result.items.map((log) => (
            <li key={log.id}>
              <Card className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="bg-base-800 text-base-50 rounded px-2 py-0.5 font-mono text-xs">
                    {log.action}
                  </span>
                  <span className="text-base-100 text-xs">{log.actorType}</span>
                  <time
                    dateTime={log.createdAt.toISOString()}
                    className="text-base-100 ml-auto text-xs tabular-nums"
                  >
                    {formatDateTimeJst(log.createdAt)}
                  </time>
                </div>

                <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                  <div className="flex gap-2">
                    <dt className="text-base-100 shrink-0">実行者</dt>
                    <dd className="break-all">{log.actorEmail ?? log.actorId ?? 'システム'}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-base-100 shrink-0">対象</dt>
                    <dd className="font-mono break-all">
                      {log.targetType ?? '—'}
                      {log.targetId ? ` / ${log.targetId}` : ''}
                    </dd>
                  </div>
                  {log.reason ? (
                    <div className="flex gap-2 sm:col-span-2">
                      <dt className="text-base-100 shrink-0">理由</dt>
                      <dd>{log.reason}</dd>
                    </div>
                  ) : null}
                  {log.ip ? (
                    <div className="flex gap-2">
                      <dt className="text-base-100 shrink-0">IP</dt>
                      <dd className="font-mono">{log.ip}</dd>
                    </div>
                  ) : null}
                  {log.requestId ? (
                    <div className="flex gap-2">
                      <dt className="text-base-100 shrink-0">リクエスト</dt>
                      <dd className="font-mono break-all">{log.requestId}</dd>
                    </div>
                  ) : null}
                </dl>

                {log.before || log.after ? (
                  <details className="text-xs">
                    <summary className="text-accent-400 cursor-pointer">変更内容</summary>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {log.before ? (
                        <div>
                          <p className="text-base-100">変更前</p>
                          <pre className="bg-base-950 border-base-800 mt-1 overflow-x-auto rounded border p-2">
                            {JSON.stringify(log.before, null, 2)}
                          </pre>
                        </div>
                      ) : null}
                      {log.after ? (
                        <div>
                          <p className="text-base-100">変更後</p>
                          <pre className="bg-base-950 border-base-800 mt-1 overflow-x-auto rounded border p-2">
                            {JSON.stringify(log.after, null, 2)}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {result.totalPages > 1 ? (
        <nav aria-label="ページ送り" className="flex items-center gap-2">
          {result.page > 1 ? (
            <Link
              href={pageHref(result.page - 1)}
              className="border-base-700 rounded-lg border px-3 py-2 text-sm"
            >
              前へ
            </Link>
          ) : null}
          <span className="text-base-100 text-sm tabular-nums">
            {result.page} / {result.totalPages}
          </span>
          {result.page < result.totalPages ? (
            <Link
              href={pageHref(result.page + 1)}
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
