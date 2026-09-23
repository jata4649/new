'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import type { EffectTier } from '@/generated/prisma/enums.ts'
import { strongestTier, TIER_PRESENTATION } from '@/lib/effects/tiers.ts'
import { cn } from '@/lib/utils.ts'

/**
 * ガチャ演出。
 *
 * ■ 演出は装飾でしかない
 *   結果はこのコンポーネントが描画される前にサーバーで確定し、DB へ記録済み。
 *   ここで受け取る prizes は「表示用のコピー」であり、
 *   このコンポーネントが何を計算しても当選内容は変わらない。
 *   途中で閉じても、再生に失敗しても、結果は /draws/[id] で確認できる。
 *
 * ■ アクセシビリティ（要件 11・16）
 *   - いつでもスキップできる（ボタン / Esc キー）。
 *     背景クリックでは閉じない。誤って触れて結果を見逃すのを避けるため。
 *   - 音は既定でオフ。オンにした設定だけを localStorage へ残す
 *   - prefers-reduced-motion のときはアニメーションを再生せず即座に全件表示する
 *   - 色だけでランクを示さず、ランク名と読み上げ用ラベルを必ず併記する
 *   - 進行状況を aria-live で伝える
 *
 * ■ 失敗時
 *   音の生成（WebAudio）は失敗しても無視する。
 *   演出全体で例外が出た場合も、呼び出し側が結果画面へ進める。
 */

export interface EffectPrize {
  sequence: number
  name: string
  tierName: string
  effectTier: EffectTier
  exchangePoints: number
  imageKey: string | null
}

const SOUND_STORAGE_KEY = 'oripa.effect.sound'

/*
 * ブラウザ側の状態（音の設定・reduced motion）は useSyncExternalStore で読む。
 * useEffect の中で setState すると、サーバー描画との差分が
 * 「一度描いてから直す」形になり、React の警告対象にもなる。
 * 外部ストアとして扱えば、初回描画の時点で正しい値が使われる。
 */

const soundListeners = new Set<() => void>()

/** 音は既定でオフ（自動再生の制限と、不意の音量事故を避けるため） */
function getSoundSnapshot(): boolean {
  try {
    return window.localStorage.getItem(SOUND_STORAGE_KEY) === 'on'
  } catch {
    // プライベートブラウジングなどで localStorage が使えない場合
    return false
  }
}

function subscribeSound(callback: () => void): () => void {
  soundListeners.add(callback)
  return () => {
    soundListeners.delete(callback)
  }
}

function setSoundPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(SOUND_STORAGE_KEY, enabled ? 'on' : 'off')
  } catch {
    // 保存できなくても演出の動作には影響しない
  }
  // localStorage は同一タブへ storage イベントを出さないので自前で通知する
  for (const listener of soundListeners) listener()
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function getReducedMotionSnapshot(): boolean {
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  } catch {
    return false
  }
}

function subscribeReducedMotion(callback: () => void): () => void {
  try {
    const query = window.matchMedia(REDUCED_MOTION_QUERY)
    query.addEventListener('change', callback)
    return () => query.removeEventListener('change', callback)
  } catch {
    return () => undefined
  }
}

/**
 * 効果音を鳴らす。
 *
 * 音声ファイルを持たず、WebAudio で単純な音を合成する。
 * 実在する音源を取り込まずに済み、リポジトリも太らない。
 */
function playTone(hz: number): void {
  try {
    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtor) return

    const context = new AudioCtor()
    const oscillator = context.createOscillator()
    const gain = context.createGain()

    oscillator.type = 'triangle'
    oscillator.frequency.value = hz
    // 短く減衰させる。音量は控えめに固定する。
    gain.gain.setValueAtTime(0.08, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.25)

    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.26)
    oscillator.onended = () => void context.close().catch(() => undefined)
  } catch {
    // 音が出せなくても演出は続ける
  }
}

export function DrawEffect({
  prizes,
  onFinish,
}: {
  prizes: EffectPrize[]
  /** 演出の終了（完了・スキップのどちらでも呼ばれる） */
  onFinish: () => void
}) {
  const [revealed, setRevealed] = useState(0)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const finished = useRef(false)

  // サーバー描画時は「音なし・動きを減らさない」を初期値にする
  const soundOn = useSyncExternalStore(subscribeSound, getSoundSnapshot, () => false)
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    () => false,
  )

  const topTier = strongestTier(prizes.map((prize) => prize.effectTier))

  const finish = useCallback(() => {
    if (finished.current) return
    finished.current = true
    for (const timer of timers.current) clearTimeout(timer)
    timers.current = []
    onFinish()
  }, [onFinish])

  const skip = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer)
    timers.current = []
    // スキップでは結果を全件表示してから終了する。
    // いきなり画面遷移すると「何が出たのか見えなかった」になるため。
    setRevealed(prizes.length)
  }, [prizes.length])

  // --- 1 枚ずつ開く ---
  useEffect(() => {
    let elapsed = 0
    const scheduled: ReturnType<typeof setTimeout>[] = []

    prizes.forEach((prize, index) => {
      // 動きを減らす設定のときは溜めを作らず、まとめて即座に出す。
      // 演出を飛ばしても結果が分からなくならないよう、表示自体は必ず行う。
      elapsed += reducedMotion ? 0 : TIER_PRESENTATION[prize.effectTier].revealDelayMs
      scheduled.push(
        setTimeout(() => {
          setRevealed(index + 1)
        }, elapsed),
      )
    })

    timers.current = scheduled
    return () => {
      for (const timer of scheduled) clearTimeout(timer)
    }
  }, [prizes, reducedMotion])

  // --- 開いた枚数に合わせて音を鳴らす ---
  const lastSounded = useRef(0)
  useEffect(() => {
    if (!soundOn || revealed === 0 || revealed === lastSounded.current) return
    const prize = prizes[revealed - 1]
    lastSounded.current = revealed
    if (prize) playTone(TIER_PRESENTATION[prize.effectTier].toneHz)
  }, [revealed, soundOn, prizes])

  // --- Esc でスキップ ---
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') skip()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [skip])

  const allRevealed = revealed >= prizes.length

  function toggleSound() {
    setSoundPreference(!soundOn)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="抽選演出"
      className={cn(
        'bg-base-950/95 fixed inset-0 z-50 flex flex-col overflow-y-auto p-4',
        topTier === 'JACKPOT' && !reducedMotion ? 'gacha-shake' : undefined,
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
        <div className="flex items-center gap-2">
          <p aria-live="polite" className="text-base-100 text-sm">
            {allRevealed
              ? `${prizes.length} 件すべて表示しました`
              : `${revealed} / ${prizes.length} 件を表示中`}
          </p>
          <button
            type="button"
            onClick={toggleSound}
            aria-pressed={soundOn}
            className="border-base-700 text-base-100 ml-auto h-11 rounded-lg border px-3 text-sm"
          >
            {soundOn ? '🔊 音あり' : '🔇 音なし'}
          </button>
          <button
            type="button"
            onClick={allRevealed ? finish : skip}
            className="bg-accent-500 text-base-950 h-11 rounded-lg px-4 text-sm font-bold"
          >
            {allRevealed ? '結果を見る' : 'スキップ'}
          </button>
        </div>

        <ul className="mt-4 grid flex-1 grid-cols-2 content-start gap-3 sm:grid-cols-3">
          {prizes.map((prize, index) => {
            const presentation = TIER_PRESENTATION[prize.effectTier]
            const isOpen = index < revealed

            return (
              <li key={prize.sequence}>
                <div
                  className={cn(
                    'rounded-card relative h-full overflow-hidden border-2 p-3',
                    isOpen ? 'gacha-reveal bg-base-900' : 'bg-base-900/40',
                  )}
                  style={{ borderColor: isOpen ? presentation.colorVar : 'transparent' }}
                >
                  {isOpen && presentation.rainbow ? (
                    <span
                      aria-hidden="true"
                      className="gacha-rainbow gacha-glow absolute inset-0 -z-10 opacity-30"
                    />
                  ) : null}

                  {isOpen ? (
                    <>
                      {prize.imageKey ? (
                        // eslint-disable-next-line @next/next/no-img-element -- 動的生成 SVG のため最適化不要
                        <img
                          src={`/api/placeholder/${encodeURIComponent(prize.imageKey)}`}
                          alt=""
                          width={120}
                          height={168}
                          className="w-full rounded-lg"
                        />
                      ) : null}
                      <p className="mt-2 text-sm font-bold">{prize.name}</p>
                      <p className="text-xs" style={{ color: presentation.colorVar }}>
                        {prize.tierName}
                        <span className="sr-only">（{presentation.srLabel}）</span>
                      </p>
                      <p className="text-base-100 text-xs tabular-nums">
                        交換 {prize.exchangePoints.toLocaleString('ja-JP')} P
                      </p>
                    </>
                  ) : (
                    <div className="flex aspect-[5/7] items-center justify-center">
                      <span aria-hidden="true" className="text-base-700 text-3xl">
                        ?
                      </span>
                      <span className="sr-only">未開封のカード</span>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>

        <p className="text-base-100/70 mt-4 text-center text-xs">
          演出は結果の表示方法にすぎません。閉じても結果は失われず、抽選履歴から確認できます。
        </p>
      </div>
    </div>
  )
}
