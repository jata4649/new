/**
 * 実在 IP（知的財産）の混入チェック。
 *
 * 要件:
 *  - 「著作権・商標上の問題を避けるため、開発環境では架空の商品名・
 *     プレースホルダー画像を使用すること」
 *  - 「実在キャラクターの画像や公式ロゴは使用しない」
 *
 * seed データに実在の作品名・キャラクター名・ブランド名が紛れ込むと、
 * スクリーンショットやデモの場で法務リスクになる。
 * seed 実行時に必ずこのチェックを通し、検出したら **失敗させる**。
 *
 * 注意: これは網羅的なブロックリストではなく、うっかり混入の検出を目的とした
 * 安全網である。最終的な確認は人が行うこと。
 */

/**
 * 検出対象。表記ゆれを拾うため小文字化して部分一致で判定する。
 * 実在の商標そのものであり、**この配列以外の場所で使ってはならない**。
 */
const BLOCKED_TERMS: readonly string[] = [
  // トレーディングカード関連の実在タイトル・ブランド
  'ポケモン',
  'pokemon',
  'pokémon',
  'ポケットモンスター',
  'ピカチュウ',
  'pikachu',
  'リザードン',
  'ミュウツー',
  '遊戯王',
  'yugioh',
  'yu-gi-oh',
  'ブルーアイズ',
  'デュエルマスターズ',
  'duel masters',
  'マジック：ザ・ギャザリング',
  'magic the gathering',
  'ワンピースカード',
  'ドラゴンボール',
  'dragon ball',
  'ヴァイスシュヴァルツ',
  'バトルスピリッツ',
  '任天堂',
  'nintendo',
  'クリーチャーズ',
  'ゲームフリーク',
  'コナミ',
  'konami',
  'バンダイ',
  'bandai',
  'wizards of the coast',
  // 鑑定会社（実在。在庫の gradingCompany には架空名を使う）
  'psa',
  'beckett',
  'bgs',
  'cgc',
  // 競合サービス名（デザイン・文言をコピーしていないことを明確にするため）
  'dopa',
  'オリパワン',
  'エクストレカ',
]

export class ForbiddenTermError extends Error {
  constructor(
    readonly term: string,
    readonly location: string,
  ) {
    super(
      `seed データに実在 IP・商標と思われる語「${term}」が含まれています（${location}）。` +
        '開発環境では完全に架空の名称を使用してください。',
    )
    this.name = 'ForbiddenTermError'
  }
}

/** 文字列に禁止語が含まれていれば最初の 1 件を返す。含まれていなければ null。 */
export function findForbiddenTerm(value: string): string | null {
  const normalized = value.toLowerCase()
  for (const term of BLOCKED_TERMS) {
    if (normalized.includes(term.toLowerCase())) {
      return term
    }
  }
  return null
}

/** 検出したら例外を投げる。seed の各レコード作成前に必ず呼ぶ。 */
export function assertNoForbiddenTerms(value: string, location: string): void {
  const term = findForbiddenTerm(value)
  if (term !== null) {
    throw new ForbiddenTermError(term, location)
  }
}

/** オブジェクトの文字列フィールドをまとめて検査する */
export function assertRecordIsClean(record: Record<string, unknown>, location: string): void {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      assertNoForbiddenTerms(value, `${location}.${key}`)
    }
  }
}
