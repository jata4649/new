import { CardCondition } from '../../src/generated/prisma/enums.ts'

/**
 * 架空カードとプレースホルダー画像の生成。
 *
 * 要件:
 *  - 「実在キャラクターの画像や公式ロゴは使用しない」
 *  - 「カード画像は単色または架空カードのプレースホルダーにする」
 *
 * 画像ファイルはリポジトリへコミットせず、画像キーから SVG をその場で生成する
 * （src/app/api/placeholder/[key]/route.ts）。
 * これにより 100 枚以上の在庫を作ってもリポジトリが太らず、
 * 実在素材が紛れ込む余地も無くなる。
 */

/** 架空のカードタイトル（作品名にあたるもの）。実在作品と重ならないよう造語で構成する。 */
export const FICTIONAL_TITLES = [
  'ルミナ・クロニクル',
  '星霜アルカディア',
  'ゼフィール戦記',
  '深淵のオルタナ',
  'クロノ・フラグメント',
] as const

/** 架空のカード名を組み立てる語彙 */
const NAME_PREFIXES = [
  '蒼焔',
  '銀嶺',
  '深碧',
  '紅蓮',
  '黎明',
  '虚空',
  '雷鳴',
  '氷晶',
  '黄昏',
  '暁光',
] as const

const NAME_CORES = [
  'ドラグーン',
  'セラフィム',
  'ワイバーン',
  'ゴーレム',
  'フェンリル',
  'キマイラ',
  'ユニコーン',
  'リヴァイアサン',
  'グリフォン',
  'バジリスク',
] as const

const NAME_SUFFIXES = ['', 'EX', 'α', '・改', 'ZERO', 'MK-II'] as const

export const RARITIES = ['C', 'UC', 'R', 'RR', 'RRR', 'SR', 'UR', 'SAR'] as const
export type Rarity = (typeof RARITIES)[number]

/** 架空の鑑定会社（実在の PSA / BGS / CGC 等は使わない） */
export const FICTIONAL_GRADERS = ['アルタ鑑定', 'ノヴァグレーディング'] as const

export interface GeneratedCard {
  code: string
  cardTitle: string
  cardName: string
  cardNumber: string
  rarity: Rarity
  condition: CardCondition
  gradingCompany: string | null
  gradingScore: string | null
  gradingCertNo: string | null
  costPriceYen: number
  referencePriceYen: number
  exchangePoints: number
  storageLocation: string
  frontImageKey: string
  backImageKey: string
}

/**
 * レアリティごとの参考価格帯（円・整数）。
 * 交換ポイントは参考価格の 70%（整数演算で切り捨て）とする。
 * 実際の運用では在庫ごとに手入力するが、seed では機械的に決める。
 */
const PRICE_BY_RARITY: Record<Rarity, { min: number; max: number }> = {
  C: { min: 30, max: 100 },
  UC: { min: 80, max: 300 },
  R: { min: 300, max: 1_000 },
  RR: { min: 1_000, max: 4_000 },
  RRR: { min: 4_000, max: 12_000 },
  SR: { min: 12_000, max: 40_000 },
  UR: { min: 40_000, max: 120_000 },
  SAR: { min: 120_000, max: 400_000 },
}

/**
 * seed の再現性のための決定的な擬似乱数（xorshift32）。
 *
 * 【重要】これは seed データ生成専用。抽選には絶対に使わない。
 * 抽選は src/lib/crypto/random.ts の CSPRNG を使用すること。
 */
export function createDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

function pick<T>(items: readonly T[], random: () => number): T {
  const index = Math.floor(random() * items.length)
  const value = items[Math.min(index, items.length - 1)]
  if (value === undefined) {
    throw new Error('候補が空です')
  }
  return value
}

function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1))
}

/** レアリティの出現比率（高レアほど少なくする） */
const RARITY_WEIGHTS: ReadonlyArray<readonly [Rarity, number]> = [
  ['C', 30],
  ['UC', 24],
  ['R', 18],
  ['RR', 12],
  ['RRR', 8],
  ['SR', 5],
  ['UR', 2],
  ['SAR', 1],
]

function pickRarity(random: () => number): Rarity {
  const total = RARITY_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0)
  let threshold = random() * total
  for (const [rarity, weight] of RARITY_WEIGHTS) {
    threshold -= weight
    if (threshold <= 0) return rarity
  }
  return 'C'
}

/**
 * 画像キー。`placeholder:<rarity>:<hue>` の形式で保存し、
 * 表示時に /api/placeholder/... で SVG を生成する。
 */
export function buildPlaceholderKey(
  rarity: Rarity,
  hue: number,
  face: 'front' | 'back',
): string {
  return `placeholder:${rarity}:${hue}:${face}`
}

export function generateCards(count: number, seed = 20260922): GeneratedCard[] {
  const random = createDeterministicRandom(seed)
  const cards: GeneratedCard[] = []

  for (let i = 0; i < count; i++) {
    const rarity = pickRarity(random)
    const range = PRICE_BY_RARITY[rarity]
    const referencePriceYen = randomInt(random, range.min, range.max)
    // 仕入原価は参考価格の 40〜70%
    const costPriceYen = Math.floor((referencePriceYen * randomInt(random, 40, 70)) / 100)
    // 交換ポイントは参考価格の 70%（1 円 = 1 ポイント）
    const exchangePoints = Math.floor((referencePriceYen * 70) / 100)

    // 高レアのみ鑑定済みにする
    const isGraded = rarity === 'UR' || rarity === 'SAR'
    const hue = randomInt(random, 0, 359)

    const name = `${pick(NAME_PREFIXES, random)}の${pick(NAME_CORES, random)}${pick(NAME_SUFFIXES, random)}`

    cards.push({
      code: `INV-${String(i + 1).padStart(5, '0')}`,
      cardTitle: pick(FICTIONAL_TITLES, random),
      cardName: name,
      cardNumber: `${String(randomInt(random, 1, 180)).padStart(3, '0')}/180`,
      rarity,
      condition: isGraded ? CardCondition.GRADED : CardCondition.NEAR_MINT,
      gradingCompany: isGraded ? pick(FICTIONAL_GRADERS, random) : null,
      gradingScore: isGraded ? String(randomInt(random, 8, 10)) : null,
      gradingCertNo: isGraded ? `AG${randomInt(random, 10_000_000, 99_999_999)}` : null,
      costPriceYen,
      referencePriceYen,
      exchangePoints,
      storageLocation: `A-${String(randomInt(random, 1, 20)).padStart(2, '0')}-${randomInt(random, 1, 50)}`,
      frontImageKey: buildPlaceholderKey(rarity, hue, 'front'),
      backImageKey: buildPlaceholderKey(rarity, hue, 'back'),
    })
  }

  return cards
}
