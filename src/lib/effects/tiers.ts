import type { EffectTier } from '@/generated/prisma/enums.ts'

/**
 * 演出ランクごとの表示設定。
 *
 * 【重要】ここは表示だけを決める。当選するかどうかとは無関係。
 *   演出は結果が確定したあとに再生されるので、
 *   この設定を書き換えても当選確率は 1 ミリも変わらない。
 *
 * 色だけでランクを示さない（必ずランク名を併記する）のはアクセシビリティ要件。
 */

export interface TierPresentation {
  /** 枠線・グローの色に使う CSS 変数名 */
  colorVar: string
  /** 1 枚あたりの演出時間（ミリ秒）。上位ほど長く「溜める」。 */
  revealDelayMs: number
  /** 虹色グラデーションを使うか */
  rainbow: boolean
  /** 画面を揺らすか（最上位のみ） */
  shake: boolean
  /** 効果音の高さ（Hz）。上位ほど高い。 */
  toneHz: number
  /** 読み上げ用の説明。演出を見られない利用者にも等級が伝わるようにする。 */
  srLabel: string
}

export const TIER_PRESENTATION: Record<EffectTier, TierPresentation> = {
  NORMAL: {
    colorVar: 'var(--color-tier-normal)',
    revealDelayMs: 140,
    rainbow: false,
    shake: false,
    toneHz: 440,
    srLabel: '通常の景品',
  },
  BLUE: {
    colorVar: 'var(--color-tier-blue)',
    revealDelayMs: 220,
    rainbow: false,
    shake: false,
    toneHz: 554,
    srLabel: '青ランクの景品',
  },
  GOLD: {
    colorVar: 'var(--color-tier-gold)',
    revealDelayMs: 320,
    rainbow: false,
    shake: false,
    toneHz: 659,
    srLabel: '金ランクの景品',
  },
  RAINBOW: {
    colorVar: 'var(--color-tier-rainbow)',
    revealDelayMs: 420,
    rainbow: true,
    shake: false,
    toneHz: 784,
    srLabel: 'レインボーランクの景品',
  },
  JACKPOT: {
    colorVar: 'var(--color-tier-jackpot)',
    revealDelayMs: 520,
    rainbow: true,
    shake: true,
    toneHz: 988,
    srLabel: '最上位ランクの景品',
  },
}

/** 演出の強さ順。10 連の「最高ランク」を決めるのに使う。 */
const TIER_STRENGTH: Record<EffectTier, number> = {
  NORMAL: 1,
  BLUE: 2,
  GOLD: 3,
  RAINBOW: 4,
  JACKPOT: 5,
}

export function strongestTier(tiers: readonly EffectTier[]): EffectTier | null {
  return tiers.reduce<EffectTier | null>((best, tier) => {
    if (!best) return tier
    return TIER_STRENGTH[tier] > TIER_STRENGTH[best] ? tier : best
  }, null)
}
