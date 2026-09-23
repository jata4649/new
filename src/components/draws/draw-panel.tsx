'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { DrawEffect, type EffectPrize } from '@/components/draws/draw-effect.tsx'
import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { postJson } from '@/lib/http/client.ts'

/**
 * 抽選の実行パネル。
 *
 * ■ 結果はサーバーが決める
 *   このコンポーネントが送るのは「口数」だけ。
 *   確率の計算も、どのスロットを引くかの決定も、一切クライアントで行わない。
 *
 * ■ 二重送信の扱い
 *   ボタンは送信中に無効化するが、それは体感のためであって保証ではない。
 *   実際の保証は冪等性キー（postJson が毎回付ける UUID）が行う。
 *   ただしキーはリクエストごとに変わるので、連打で 2 回引けてしまわないよう
 *   「送信中は次の送信を開始しない」ことをこの層でも守る。
 *
 * ■ 通信が切れた場合
 *   結果はサーバー側で確定済みなので、履歴（/mypage/draws）から確認できる。
 *   画面にもその旨を出す。
 *
 * ■ 演出との関係
 *   サーバーから結果を受け取ってから演出を再生し、終わったら結果画面へ移る。
 *   演出中に閉じられても結果は DB にあるため失われない。
 *   リプレイ（同じ冪等性キーの再送）のときは演出を飛ばす。
 *   すでに見た結果をもう一度見せられても嬉しくないため。
 */

const DRAW_OPTIONS = [
  { count: 1, label: '1 回引く' },
  { count: 10, label: '10 連で引く' },
] as const

interface DrawSuccess {
  drawTransactionId: string
  prizes: EffectPrize[]
}

export function DrawPanel({
  slug,
  unitPricePoints,
  spendableBalance,
  remainingSlots,
  remainingQuota,
}: {
  slug: string
  unitPricePoints: number
  spendableBalance: number
  remainingSlots: number
  /** 残り購入可能口数。null なら上限なし。 */
  remainingQuota: number | null
}) {
  const router = useRouter()
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  /** 演出中の結果。null なら演出していない。 */
  const [effect, setEffect] = useState<DrawSuccess | null>(null)

  function reasonToDisable(count: number): string | null {
    const total = unitPricePoints * count
    if (remainingSlots < count) return `残り口数が足りません（残り ${remainingSlots} 口）`
    if (spendableBalance < total) {
      return `ポイントが不足しています（必要 ${total.toLocaleString('ja-JP')} P）`
    }
    if (remainingQuota !== null && remainingQuota < count) {
      return `購入上限まであと ${remainingQuota} 口です`
    }
    return null
  }

  async function handleDraw(count: number) {
    if (pendingCount !== null) return

    const total = unitPricePoints * count
    const confirmed = window.confirm(
      `${count} 口引きます。\n\n` +
        `消費ポイント: ${total.toLocaleString('ja-JP')} P\n` +
        `抽選後の残高: ${(spendableBalance - total).toLocaleString('ja-JP')} P\n\n` +
        '抽選結果は実行した時点で確定します。よろしいですか？',
    )
    if (!confirmed) return

    setError(undefined)
    setNotice(undefined)
    setPendingCount(count)

    try {
      const result = await postJson<DrawSuccess>(`/api/oripas/${slug}/draw`, 'POST', {
        drawCount: count,
        expectedUnitPricePoints: unitPricePoints,
      })

      if (!result.ok) {
        setError(result.message)
        if (result.code === 'NETWORK_ERROR') {
          setNotice(
            '通信に失敗しました。抽選が成立している可能性があるため、' +
              '同じ操作を繰り返す前に抽選履歴を確認してください。',
          )
        }
        // 残り口数や残高が変わっている可能性があるので、表示を更新する
        router.refresh()
        return
      }

      if (result.replayed) {
        // 再送で返ってきた記録済みの結果。演出はせず結果画面へ。
        router.push(`/draws/${result.data.drawTransactionId}`)
        router.refresh()
        return
      }

      // 演出を再生する。結果はすでに確定しているので、
      // ここで何が起きても当選内容は変わらない。
      setEffect(result.data)
    } finally {
      setPendingCount(null)
    }
  }

  function finishEffect() {
    const id = effect?.drawTransactionId
    setEffect(null)
    if (id) {
      router.push(`/draws/${id}`)
      router.refresh()
    }
  }

  return (
    <div className="space-y-4">
      {effect ? <DrawEffect prizes={effect.prizes} onFinish={finishEffect} /> : null}

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? (
        <Alert tone="warning">
          {notice}{' '}
          <a href="/mypage/draws" className="text-accent-400 underline">
            抽選履歴を見る
          </a>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row">
        {DRAW_OPTIONS.map((option) => {
          const disabledReason = reasonToDisable(option.count)
          const total = unitPricePoints * option.count

          return (
            <div key={option.count} className="flex-1 space-y-1.5">
              <Button
                type="button"
                size="lg"
                className="w-full"
                variant={option.count === 10 ? 'primary' : 'secondary'}
                disabled={pendingCount !== null || disabledReason !== null}
                onClick={() => void handleDraw(option.count)}
              >
                {pendingCount === option.count ? '抽選中…' : option.label}
              </Button>
              <p className="text-base-100 text-center text-xs tabular-nums">
                {total.toLocaleString('ja-JP')} P
              </p>
              {disabledReason ? (
                <p className="text-center text-xs text-amber-300">{disabledReason}</p>
              ) : null}
            </div>
          )
        })}
      </div>

      <p className="text-base-100/70 text-xs">
        抽選結果はサーバー側で確定してから画面に表示されます。
        途中で画面を閉じても、結果は抽選履歴から確認できます。
      </p>
    </div>
  )
}
