import { MAX_SLOTS_PER_DRAW } from '@/lib/config/draws.ts'
import type { PrismaTransactionClient } from '@/server/db.ts'

/**
 * 抽選スロットへの低レベルアクセス。
 *
 * Prisma の API では `FOR UPDATE SKIP LOCKED` を表現できないため、
 * **このファイルに限って**生 SQL を使う。
 * 値は必ずパラメータとして渡し、文字列連結はしない。
 *
 * ビジネス判断はここに書かない（service.ts が行う）。
 */

/**
 * 抽選するスロットを確保する（有限プール方式の核心）。
 *
 * ■ なぜ `ORDER BY draw_order LIMIT n FOR UPDATE SKIP LOCKED` なのか
 *
 *   draw_order は公開前に CSPRNG でシャッフル済みの順列なので、
 *   「先頭から n 件」を取るだけで一様な非復元抽出になる。
 *   `oripa_slots_available_draw_order_idx`（status='AVAILABLE' の部分インデックス）
 *   の先頭だけを見るため、売れ進んでも計算量が増えない。
 *
 *   `SKIP LOCKED` により、他のトランザクションがロック中の行は待たずに飛ばす。
 *   同時に 100 リクエストが来ても各々が別の行を即座に掴むので、
 *   ロック待ち行列が発生しない。
 *
 * ■ なぜ二重当選が起きないのか
 *
 *   行ロックを取った時点で、他のトランザクションは同じ行を選べない。
 *   さらに service.ts が続けて
 *   `UPDATE ... WHERE id IN (...) AND status = 'AVAILABLE'` を実行し、
 *   更新件数が要求数と一致しなければトランザクションごとロールバックする。
 *   ロックの取りこぼしがあっても、条件付き UPDATE で必ず検出される。
 *
 * ■ 返すのは ID だけ
 *
 *   景品の内容は呼び出し側が別クエリで取る。
 *   結合した表まで巻き込んでロックしないため、
 *   および「ロックできた行だけ」を確実に扱うため。
 */
export async function reserveAvailableSlots(
  tx: PrismaTransactionClient,
  campaignId: string,
  count: number,
): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SLOTS_PER_DRAW) {
    // サービス層で検証済み。ここは生 SQL へ渡る値の最終防衛線。
    throw new Error(`確保するスロット数が不正です: ${count}`)
  }

  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM oripa_slots
    WHERE campaign_id = ${campaignId}
      AND status = 'AVAILABLE'
    ORDER BY draw_order
    LIMIT ${count}
    FOR UPDATE SKIP LOCKED
  `

  return rows.map((row) => row.id)
}
