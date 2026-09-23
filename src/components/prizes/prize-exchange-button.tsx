'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { postJson } from '@/lib/http/client.ts'

/**
 * 当選商品のポイント交換ボタン。
 *
 * ■ 取消不可であることを 2 段階で伝える
 *   1. ボタンの近くに常時表示する注意書き
 *   2. 実行前の確認ダイアログで、付与ポイントと「取消できない」ことを明示する
 *
 *   API 側も本文に confirm: true を要求するので、
 *   画面の確認を飛ばして呼んでも意図の確認は残る。
 *
 * ■ 二重実行の防止
 *   送信中はボタンを無効化するが、保証は冪等性キー（postJson が毎回付ける）と
 *   サーバー側の条件付き UPDATE が行う。
 */

interface ExchangeSuccess {
  name: string
  grantedPoints: number
  balanceAfter: number
}

export function PrizeExchangeButton({
  prizeId,
  prizeName,
  exchangePoints,
  disabled,
}: {
  prizeId: string
  prizeName: string
  exchangePoints: number
  disabled?: boolean
}) {
  const router = useRouter()
  const [error, setError] = useState<string | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [isPending, setIsPending] = useState(false)

  async function handleExchange() {
    if (isPending) return

    const confirmed = window.confirm(
      `「${prizeName}」をポイントへ交換します。\n\n` +
        `付与されるポイント: ${exchangePoints.toLocaleString('ja-JP')} P（無償ポイント）\n\n` +
        '【重要】交換すると商品は手元から無くなり、この操作は取り消せません。\n' +
        '発送を希望する場合は交換せず、発送申請を行ってください。\n\n' +
        'よろしいですか？',
    )
    if (!confirmed) return

    setError(undefined)
    setMessage(undefined)
    setIsPending(true)

    try {
      const result = await postJson<ExchangeSuccess>(
        `/api/prizes/${prizeId}/exchange`,
        'POST',
        { confirm: true, expectedExchangePoints: exchangePoints },
      )

      if (!result.ok) {
        setError(result.message)
        // 状態が変わっている可能性があるので表示を更新する
        router.refresh()
        return
      }

      setMessage(
        `${result.data.grantedPoints.toLocaleString('ja-JP')} P を付与しました` +
          `（残高: ${result.data.balanceAfter.toLocaleString('ja-JP')} P）`,
      )
      router.refresh()
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="space-y-2">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}

      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="w-full"
        disabled={disabled || isPending}
        onClick={() => void handleExchange()}
      >
        {isPending ? '交換中…' : `${exchangePoints.toLocaleString('ja-JP')} P へ交換`}
      </Button>
      <p className="text-base-100/70 text-xs">交換すると取り消せません。</p>
    </div>
  )
}
