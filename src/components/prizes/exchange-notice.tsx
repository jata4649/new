'use client'

import { useEffect, useSyncExternalStore } from 'react'

import { Alert } from '@/components/ui/alert.tsx'

/**
 * 交換結果の通知。
 *
 * ■ なぜ交換ボタンの中に置かないか
 *   交換に成功すると当選商品は UNDECIDED ではなくなり、
 *   router.refresh() のあとは交換ボタン自体が描画されなくなる。
 *   通知をボタンと同じコンポーネントに持たせると、
 *   ボタンの巻き添えで通知まで消えてしまい、
 *   「取り消せない操作をしたのに、結果が一瞬しか出ない」ことになる。
 *   そのため通知は一覧の外（再描画で消えない位置）へ置き、
 *   ボタンからは小さなストア越しに知らせる。
 *
 * ■ ストアの寿命
 *   モジュール変数はページを離れても残るため、
 *   通知領域のアンマウント時に必ず空へ戻す。
 *   そうしないと、別の画面から戻ったときに古い通知が出てしまう。
 */

export interface ExchangeNotice {
  tone: 'success' | 'error'
  text: string
}

let current: ExchangeNotice | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** 交換ボタンから結果を知らせる */
export function publishExchangeNotice(notice: ExchangeNotice | null): void {
  current = notice
  emit()
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

/** 同じ参照を返す（毎回新しい値を返すと useSyncExternalStore が再描画を繰り返す） */
function getSnapshot(): ExchangeNotice | null {
  return current
}

function getServerSnapshot(): ExchangeNotice | null {
  return null
}

export function ExchangeNoticeRegion() {
  const notice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  useEffect(() => {
    return () => {
      // 画面を離れたら通知を捨てる（次に開いたときへ持ち越さない）
      current = null
    }
  }, [])

  if (!notice) return null

  return <Alert tone={notice.tone}>{notice.text}</Alert>
}
