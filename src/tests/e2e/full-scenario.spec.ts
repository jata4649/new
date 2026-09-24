import { expect, test, type Page } from '@playwright/test'

import { completeDrawEffect } from './support/draw-flow.ts'

/**
 * 通しシナリオの E2E（Phase 8 / 要件 14）。
 *
 * 管理者ログイン → 在庫登録 → オリパ作成 → 景品割当 → 公開 →
 * ユーザー登録 → テストポイント購入 → 抽選 → 演出 → ポイント交換 →
 * 発送申請 → 発送処理（検品・梱包・発送済み）→ シード公開
 *
 * ■ なぜ通しで 1 本書くのか
 *   個々の機能は各 spec で細かく検証している。
 *   ここで見たいのは「繋ぎ目」だけ。
 *   画面をまたいだときに状態が食い違わないこと、
 *   ある工程の出力が次の工程の入力として成立することを確かめる。
 *
 * ■ 毎回まっさらなデータで流す
 *   seed の sample-* には触れない。在庫もオリパもこのテストが作る。
 *   既存データに依存すると、前回の実行結果で落ちるようになる。
 */

const ADMIN_EMAIL = 'admin@example.test'
const ADMIN_PASSWORD = 'TestPassword123!'
const USER_PASSWORD = 'E2eFullScenario1'

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
}

/** datetime-local が読める "YYYY-MM-DDTHH:mm"（ブラウザのローカル時刻 = JST） */
function toLocalInput(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000)
  return jst.toISOString().slice(0, 16)
}

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL)
  await page.getByLabel('パスワード').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'ログイン' }).click()
  await expect(page).toHaveURL(/\/mypage/)
}

async function registerInventory(page: Page, code: string, name: string): Promise<void> {
  await page.goto('/admin/inventories/new')
  await page.getByLabel('在庫コード').fill(code)
  await page.getByLabel('タイトル（架空名）').fill('ルミナ・クロニクル')
  await page.getByLabel('カード名（架空名）').fill(name)
  await page.getByLabel('レアリティ').fill('SR')
  await page.getByLabel('交換ポイント').fill('1200')
  await page.getByRole('button', { name: '登録する' }).click()

  await expect(page).toHaveURL(/\/admin\/inventories\/[^/]+$/)
  await expect(page.getByText(code)).toBeVisible()
}

test('通しシナリオ: 在庫登録から発送とシード公開まで', async ({ page }) => {
  test.slow()

  const suffix = uniqueSuffix()
  const slug = `e2e-full-${suffix}`.toLowerCase()
  const oripaName = `E2E 通しテスト ${suffix}`
  const userEmail = `e2e-full-${suffix}@example.test`
  const recipient = `架空 通し${suffix}`

  /* ---------------- 1. 管理者が在庫を 2 件登録する ---------------- */

  const codeA = `FULL-${suffix}-A`.toUpperCase()
  const codeB = `FULL-${suffix}-B`.toUpperCase()

  await loginAsAdmin(page)
  await registerInventory(page, codeA, `架空カード A ${suffix}`)
  await registerInventory(page, codeB, `架空カード B ${suffix}`)

  /* ---------------- 2. オリパの下書きを作る（総口数 2） ---------------- */

  await page.goto('/admin/oripas/new')
  await page.getByLabel('スラッグ（URL）').fill(slug)
  await page.getByLabel('名称').fill(oripaName)
  await page.getByLabel('1 口価格（ポイント）').fill('100')
  await page.getByLabel('総口数').fill('2')

  const start = new Date(Date.now() - 60 * 60 * 1000)
  const end = new Date(Date.now() + 2 * 60 * 60 * 1000)
  await page.getByLabel('販売開始日時').fill(toLocalInput(start))
  await page.getByLabel('販売終了日時').fill(toLocalInput(end))

  /*
   * 既定のランクは S(1) / A(9) / B(90)。3 つ目を削り、A を 1 にして 1 + 1 = 2 に合わせる。
   *
   * 口数の入力は id で指定する。getByLabel('口数') は
   * 「総口数」「1 ユーザーあたりの上限口数」にも一致してしまい、
   * 別の項目へ値を入れてしまう（実際に一度それで落ちた）。
   */
  await page.getByRole('button', { name: '削除' }).nth(2).click()
  await page.locator('#tier-count-1').fill('1')
  await expect(page.getByText('ランク口数の合計: 2 / 総口数: 2（一致）')).toBeVisible()

  await page.getByRole('button', { name: '下書きを作成する' }).click()
  /*
   * 作成後の詳細ページへ遷移するのを待つ。
   *
   * /admin/oripas/[^/]+$ だと作成フォーム（/admin/oripas/new）にも一致してしまい、
   * 遷移前の URL を掴んだまま先へ進んでしまう（実際にそれで落ちた）。
   * new を明示的に除く。
   */
  await expect(page).toHaveURL(/\/admin\/oripas\/(?!new$)[^/]+$/)
  const oripaAdminUrl = page.url()

  /* ---------------- 3. 物理在庫を両ランクへ割り当てる ---------------- */

  /*
   * 在庫はコードで選ぶ。
   *
   * .first() で選ぶと両ランクが同じ在庫を指してしまう。
   * 1 つの物理在庫は 1 か所にしか割り当てられないので、
   * 2 つ目のランクではその行が無効化され、クリックできない。
   */
  const sFieldset = page.getByRole('group').filter({ hasText: 'S賞（S）' })
  await sFieldset.getByRole('listitem').filter({ hasText: codeA }).getByRole('checkbox').check()

  const aFieldset = page.getByRole('group').filter({ hasText: 'A賞（A）' })
  await aFieldset.getByRole('listitem').filter({ hasText: codeB }).getByRole('checkbox').check()

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'スロットを生成する' }).click()
  await expect(page.getByText(/2 件のスロットを生成しました/)).toBeVisible()

  /* ---------------- 4. 公開する ---------------- */

  await page.reload()
  await expect(page.getByText('すべての公開条件を満たしています。')).toBeVisible()

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '公開する' }).click()
  await expect(page.getByText('公開しました。')).toBeVisible()

  await page.reload()
  await expect(page.getByText('公正性の記録（コミット＆リビール）')).toBeVisible()
  // 販売中はシードを公開できない
  await expect(page.getByRole('button', { name: 'シードを公開する' })).toHaveCount(0)

  /* ---------------- 5. 利用者が登録してポイントを得る ---------------- */

  await page.goto('/logout').catch(() => undefined)
  await page.goto('/signup')
  await page.getByLabel('表示名').fill('通しテスト利用者')
  await page.getByLabel('メールアドレス').fill(userEmail)
  await page.getByLabel('パスワード').fill(USER_PASSWORD)
  await page.getByText('利用規約とプライバシーポリシーに同意します').click()
  await page.getByRole('button', { name: '登録する' }).click()
  await expect(page).toHaveURL(/\/mypage/, { timeout: 15_000 })

  await page.goto('/mypage/points/purchase')
  await page.getByLabel('金額').selectOption('1000')
  await page.getByRole('button', { name: 'テスト決済を作成' }).click()
  await page.getByRole('button', { name: '決済成功にする' }).click()
  await expect(page.getByText(/ポイントを付与しました/)).toBeVisible()

  /* ---------------- 6. 抽選と演出（2 回引いて完売させる） ---------------- */

  for (let i = 0; i < 2; i += 1) {
    await page.goto(`/oripas/${slug}/draw`)
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '1 回引く' }).click()
    await completeDrawEffect(page, 1)
    await expect(page.getByRole('heading', { name: '抽選結果', level: 1 })).toBeVisible()
  }

  // 完売したので、もう引けない
  await page.goto(`/oripas/${slug}`)
  await expect(page.getByText('0 / 2')).toBeVisible()

  /* ---------------- 7. 片方をポイント交換する ---------------- */

  await page.goto('/mypage/prizes')
  await expect(page.getByText('未選択の商品が 2 件あります。')).toBeVisible()

  page.once('dialog', (dialog) => void dialog.accept())
  await page
    .getByRole('button', { name: /P へ交換$/ })
    .first()
    .click()
  await expect(page.getByText(/P を付与しました/)).toBeVisible()

  /* ---------------- 8. もう片方を発送申請する ---------------- */

  await page.goto('/mypage/addresses')
  await page.getByLabel('宛名').fill(recipient)
  await page.getByLabel('郵便番号').fill('1500001')
  await page.getByLabel('都道府県').selectOption('東京都')
  await page.getByLabel('市区町村').fill('渋谷区')
  await page.getByLabel('番地').fill('神南 1-2-3')
  await page.getByLabel('電話番号').fill('09012345678')
  await page.getByRole('button', { name: '登録する' }).click()
  await expect(page.getByRole('listitem').getByText(recipient).first()).toBeVisible()

  await page.goto('/mypage/prizes')
  const panel = page.getByRole('group').filter({ hasText: '発送する商品' })
  await panel.getByRole('checkbox').first().check()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: /点の発送を申請する$/ }).click()

  await expect(page).toHaveURL(/\/mypage\/shipments$/)
  await expect(page.getByRole('listitem').getByText('申請受付').first()).toBeVisible()

  // 未選択は無くなった（1 件は交換、1 件は申請中）
  await page.goto('/mypage/prizes')
  await expect(page.getByText(/未選択の商品が/)).toHaveCount(0)

  /* ---------------- 9. 管理者が発送作業を進める ---------------- */

  await loginAsAdmin(page)
  await page.goto(`/admin/shipping-requests?userEmail=${encodeURIComponent(userEmail)}`)
  await page.getByRole('link', { name: new RegExp(`${recipient} 宛`) }).click()
  await expect(page).toHaveURL(/\/admin\/shipping-requests\/[^/]+$/)

  await page.getByRole('button', { name: '検品を開始する' }).click()
  await expect(page.getByText('検品を開始しました。')).toBeVisible()
  await page.getByRole('button', { name: '梱包を開始する' }).click()
  await expect(page.getByText('梱包を開始しました。')).toBeVisible()

  await page.getByLabel('配送業者').fill('架空エクスプレス')
  await page.getByLabel('追跡番号').fill('9876543210')
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '発送済みにする' }).click()
  await expect(page.getByText('発送済みにしました。')).toBeVisible()

  /* ---------------- 10. シードを公開して第三者が検証できる状態にする ---------------- */

  // 完売しているので販売は終了している
  await page.goto(oripaAdminUrl)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'シードを公開する' }).click()
  await expect(page.getByText('シードを公開しました。')).toBeVisible()

  // ユーザー向けの画面に検証用の材料がすべて揃う
  const response = await page.goto(`/oripas/${slug}`)
  const html = (await response?.text()) ?? ''
  await expect(page.getByText('検証の手順')).toBeVisible()
  expect(html).toContain('抽選順のランクコード')

  /* ---------------- 11. 監査ログに一連の操作が残っている ---------------- */

  /*
   * 絞り込みの <option> にも同じ文字列があるので、一覧の中に限定して探す。
   * option は非表示なので、そのまま探すと「あるのに見えない」で落ちる。
   */
  await page.goto('/admin/audit-logs?action=ORIPA_SEED_REVEAL')
  await expect(page.getByRole('listitem').getByText('ORIPA_SEED_REVEAL').first()).toBeVisible()

  await page.goto('/admin/audit-logs?action=SHIPPING_STATUS_UPDATE')
  await expect(
    page.getByRole('listitem').getByText('SHIPPING_STATUS_UPDATE').first(),
  ).toBeVisible()

  /* ---------------- 12. 利用者側に追跡番号が出ている ---------------- */

  await page.goto('/login')
  await page.getByLabel('メールアドレス').fill(userEmail)
  await page.getByLabel('パスワード').fill(USER_PASSWORD)
  await page.getByRole('button', { name: 'ログイン' }).click()
  await expect(page).toHaveURL(/\/mypage/)

  await page.goto('/mypage/shipments')
  await expect(page.getByRole('listitem').getByText('発送済み').first()).toBeVisible()
  await expect(page.getByText('9876543210')).toBeVisible()
})
