import { expect, type Page } from '@playwright/test'

/**
 * 抽選まわりの E2E 共通処理。
 *
 * Phase 6 で演出を挟んだため、抽選ボタンを押しても即座に結果画面へは行かない。
 * 「演出を進める」手順を spec ごとに書き写すと、演出を変えたときに
 * 片方だけ直し忘れる（実際に Phase 6 で draw.spec.ts が取り残され、CI が落ちた）。
 * そのため手順はここへ一本化する。
 */

/** E2E が消費してよい専用オリパ（3,000 口・1 口 100 P） */
export const DRAW_POOL_SLUG = 'e2e-draw-pool'
export const DRAW_POOL_NAME = 'E2E テスト用オリパ（大容量）'
/** 専用オリパの 1 口価格 */
export const DRAW_POOL_UNIT_PRICE = 100

/** 演出のダイアログ */
export function drawEffect(page: Page) {
  return page.getByRole('dialog', { name: '抽選演出' })
}

/**
 * 演出を全件表示まで進め、結果画面へ遷移する。
 *
 * スキップは Esc キーで行う。ボタンは開封中「スキップ」・全件表示後「結果を見る」と
 * 同じ位置でラベルだけが入れ替わるため、ラベルを読んでから押すと
 * 「読んだ直後に切り替わって、押したら演出が終わっていた」という競合が起きる。
 * Esc は何度押しても全件表示にするだけで演出を終わらせないので、
 * どちらの状態でも安全に押せる。
 */
export async function completeDrawEffect(page: Page, expectedCount: number): Promise<void> {
  const effect = drawEffect(page)
  await expect(effect).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(effect.getByText(`${expectedCount} 件すべて表示しました`)).toBeVisible()

  await effect.getByRole('button', { name: '結果を見る' }).click()
  await expect(page).toHaveURL(/\/draws\/[^/]+$/)
}

/** 抽選ボタンを押して確認ダイアログを承諾し、演出を抜けて結果画面まで進む */
export async function drawThroughEffect(
  page: Page,
  drawCount: 1 | 10,
  options: { slug?: string } = {},
): Promise<void> {
  const slug = options.slug ?? DRAW_POOL_SLUG

  await page.goto(`/oripas/${slug}/draw`)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: drawCount === 1 ? '1 回引く' : '10 連で引く' }).click()

  await completeDrawEffect(page, drawCount)
}
