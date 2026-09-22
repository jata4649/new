import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'

/**
 * 暗号学的に安全な乱数ユーティリティ。
 *
 * 要件: 「抽選では暗号学的に安全な乱数生成を使用すること。Math.random() だけに依存しないこと」
 *
 * このファイル以外で Math.random() を使うことは ESLint の no-restricted-properties で禁止している。
 * ここでも Math.random() は一切使用していない。
 */

/**
 * 0 以上 max 未満の整数を返す。
 * node:crypto の randomInt は拒否サンプリングを行うためモジュロバイアスが無い。
 */
export function secureRandomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0) {
    throw new RangeError(`max は 1 以上の整数である必要があります: ${max}`)
  }
  return randomInt(max)
}

/**
 * Fisher-Yates シャッフル（in-place ではなく新しい配列を返す）。
 *
 * 有限プール抽選では、販売開始前にこの関数で全スロットの抽選順を決定する。
 * これにより
 *   - 抽選そのものは「先頭から順に取る」だけになり O(log n) で競合に強い
 *   - 非復元抽出として分布が厳密に正しい
 *   - 順列のハッシュを公開時にコミットすれば、後からの差し替えを検証できる
 * という 3 つを同時に満たす。詳細は docs/06-draw-algorithm.md を参照。
 */
export function secureShuffle<T>(items: readonly T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1)
    const a = result[i]
    const b = result[j]
    // noUncheckedIndexedAccess 下での安全な入れ替え（範囲内なので undefined にはならない）
    if (a === undefined || b === undefined) {
      throw new Error('シャッフル中に範囲外アクセスが発生しました')
    }
    result[i] = b
    result[j] = a
  }
  return result
}

/**
 * 1..n の整数をシャッフルした順列を返す。スロットの drawOrder 生成に使う。
 * n が大きい場合でも配列 1 本で済ませる（総口数は高々数十万を想定）。
 */
export function secureShuffledSequence(n: number): number[] {
  if (!Number.isInteger(n) || n <= 0) {
    throw new RangeError(`n は 1 以上の整数である必要があります: ${n}`)
  }
  const sequence = Array.from({ length: n }, (_, i) => i + 1)
  return secureShuffle(sequence)
}

/** 冪等性キーやトークンに使うランダム文字列（URL-safe base64） */
export function secureToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url')
}

export function newRequestId(): string {
  return randomUUID()
}

/** トークンは平文保存しない。保存・照合にはこのハッシュを使う。 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * 抽選順のコミットハッシュを作る。
 *
 * 公開時に serverSeed（非公開）と、スロット順に並べたランクコードから
 * ハッシュを計算して campaign.slotOrderCommit に保存する。
 * 販売終了後に serverSeed を公開すれば、第三者が
 *   - 途中で景品構成が差し替えられていないこと
 *   - 公開時点で順序が確定していたこと
 * を検証できる（コミット＆リビール方式）。
 */
export function buildSlotOrderCommitment(input: {
  campaignId: string
  serverSeed: string
  /** drawOrder 昇順に並べたランクコード（例: ['D','D','B','S',...]） */
  tierCodesInDrawOrder: readonly string[]
}): string {
  const payload = [
    input.campaignId,
    input.serverSeed,
    input.tierCodesInDrawOrder.join(','),
  ].join('|')
  return sha256Hex(payload)
}

/**
 * タイミング攻撃に強い文字列比較。Webhook 署名や Basic 認証の照合で使う。
 * 長さが異なる場合も一定時間で false を返すため、長さの差から情報が漏れない。
 */
export function secureCompare(a: string, b: string): boolean {
  // 長さの違いを隠すため、先にハッシュ化して固定長にしてから比較する
  const bufA = createHash('sha256').update(a, 'utf8').digest()
  const bufB = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(bufA, bufB)
}
