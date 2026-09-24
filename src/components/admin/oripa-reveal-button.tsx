'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { postJson } from '@/lib/http/client.ts'

/**
 * シードの公開（リビール）。
 *
 * ■ 公開できる条件はサーバーが決める
 *   販売終了後・未公開・コミットハッシュとスロット順が一致、の 3 つ。
 *   画面でもボタンを出し分けるが、判定の正はサーバー側にある。
 *
 * ■ 取り消せない
 *   公開日時が入ったら二度と変えられない。
 *   「公開したことにして後から差し替える」余地を残さないための設計なので、
 *   確認ダイアログでもその旨を明示する。
 */
export function OripaRevealButton({
  campaignId,
  canReveal,
  blockedReason,
}: {
  campaignId: string
  canReveal: boolean
  /** 公開できない理由。null なら公開できる。 */
  blockedReason: string | null
}) {
  const router = useRouter()
  const [error, setError] = useState<string | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, setIsPending] = useState(false)

  async function handleReveal() {
    if (isPending) return

    const confirmed = window.confirm(
      'このオリパのシードを公開します。\n\n' +
        '公開するとユーザー向けの画面にシードが表示され、\n' +
        '第三者がコミットハッシュを検証できるようになります。\n\n' +
        '【重要】一度公開すると取り消せません。\n\n' +
        'よろしいですか？',
    )
    if (!confirmed) return

    setError(undefined)
    setMessage(undefined)
    setIsPending(true)

    try {
      const result = await postJson<{ revealedAt: string }>(
        `/api/admin/oripas/${campaignId}/reveal`,
        'POST',
        { confirm: true },
      )
      if (!result.ok) {
        setError(result.message)
        router.refresh()
        return
      }
      setMessage('シードを公開しました。ユーザー向けの画面から検証できます。')
      router.refresh()
    } finally {
      setIsPending(false)
    }
  }

  /*
   * 結果の表示はボタンの有無と切り離す。
   *
   * 公開に成功すると canReveal は false になる。
   * 「ボタンが出るときだけ結果も出す」形にすると、
   * 成功メッセージがボタンの巻き添えで消えてしまう。
   */
  return (
    <div className="mt-4 space-y-2">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      {canReveal ? (
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={isPending}
            onClick={() => void handleReveal()}
          >
            {isPending ? '公開中…' : 'シードを公開する'}
          </Button>
          <p className="text-base-100/70 text-xs">
            公開前に、保存済みのスロット順から再計算したハッシュがコミットハッシュと
            一致することをサーバー側で確認します。一致しない場合は公開しません。
          </p>
        </>
      ) : blockedReason ? (
        <p className="text-base-100/70 text-xs">{blockedReason}</p>
      ) : null}
    </div>
  )
}
