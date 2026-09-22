import { expect, test, type Page } from '@playwright/test'

/**
 * オリパの E2E（Phase 4）。
 *
 * 前提: `pnpm db:seed` 済みであること。
 *   販売中 3 種 / 販売前 1 種 / 完売 1 種が作られている。
 *
 * ここで最も重視するのは「抽選順とシードが外へ出ていないこと」。
 * 画面に出ていなくても HTML や API の応答に混ざっていれば漏洩なので、
 * 応答本文そのものを検査する。
 */

const PASSWORD = 'TestPassword123!'

async function login(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('メールアドレス').fill(email)
  await page.getByLabel('パスワード').fill(PASSWORD)
  await page.getByRole('button', { name: 'ログイン' }).click()
}

/** テストごとに一意なスラッグを作る（再実行しても衝突しないように） */
function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

test.describe('ユーザー向けの表示', () => {
  test('未ログインでもオリパ一覧を見られる', async ({ page }) => {
    await page.goto('/oripas')

    await expect(page.getByRole('heading', { name: 'オリパ一覧', level: 1 })).toBeVisible()
    await expect(page.getByRole('link', { name: 'サンプル・スタンダードオリパ' })).toBeVisible()
  })

  test('下書きではない公開済みオリパだけが並ぶ', async ({ page }) => {
    await page.goto('/oripas')

    // 完売・販売前も一覧には出る（状態バッジで区別する）
    await expect(page.getByRole('link', { name: 'サンプル・完売オリパ' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'サンプル・販売前オリパ' })).toBeVisible()
  })

  test('詳細で確率と当たり残数を確認できる', async ({ page }) => {
    await page.goto('/oripas/sample-standard-01')

    await expect(
      page.getByRole('heading', { name: 'サンプル・スタンダードオリパ', level: 1 }),
    ).toBeVisible()
    await expect(page.getByText('当選確率と残り本数')).toBeVisible()

    // S 賞は 1/100 = 1.000%
    const row = page.getByRole('row').filter({ hasText: 'S賞' })
    await expect(row).toContainText('1.000%')
    await expect(row).toContainText('1/100')
  })

  test('完売オリパは残り 0 と表示される', async ({ page }) => {
    await page.goto('/oripas/sample-soldout-01')

    await expect(page.getByText('完売', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('0 / 30')).toBeVisible()
  })

  test('公開前のシードが HTML に含まれない（最重要）', async ({ page, request }) => {
    const response = await page.goto('/oripas/sample-standard-01')
    const html = (await response?.text()) ?? ''

    // コミットハッシュは公開してよい。シードと抽選順は出してはならない。
    expect(html).toContain('コミットハッシュ')
    expect(html).toContain('販売終了後に公開します')
    expect(html).not.toContain('slotOrderSeed')
    expect(html).not.toContain('drawOrder')
    expect(html).not.toContain('draw_order')

    // API 応答も同様
    const api = await request.get('/api/oripas/sample-standard-01')
    expect(api.ok()).toBe(true)
    const body = await api.text()
    expect(body).not.toContain('slotOrderSeed')
    expect(body).not.toContain('drawOrder')
    expect(JSON.parse(body).data.revealedSeed).toBeNull()
  })

  test('公開 API は抽選対象のスロット ID を返さない', async ({ request }) => {
    const response = await request.get('/api/oripas/sample-standard-01')
    const body = await response.json()

    expect(body.data.slotOrderCommit).toMatch(/^[0-9a-f]{64}$/)
    // 上位景品は見せるが、slotId は含めない（クライアントから狙い撃ちさせない）
    for (const prize of body.data.topPrizes) {
      expect(prize).not.toHaveProperty('slotId')
      expect(prize).not.toHaveProperty('id')
    }
  })

  test('存在しないスラッグは 404 になる', async ({ page }) => {
    const response = await page.goto('/oripas/does-not-exist-9999')
    expect(response?.status()).toBe(404)
  })
})

test.describe('管理画面の認可', () => {
  test('一般ユーザーはオリパ管理へ入れない', async ({ page }) => {
    await login(page, 'user1@example.test')
    await expect(page).toHaveURL(/\/mypage/)

    await page.goto('/admin/oripas')
    await expect(page).not.toHaveURL(/\/admin/)
  })

  test('一般ユーザーは在庫管理へ入れない', async ({ page }) => {
    await login(page, 'user1@example.test')
    await page.goto('/admin/inventories')
    await expect(page).not.toHaveURL(/\/admin/)
  })

  test('未ログインで管理 API を叩くと 401 になる', async ({ request }) => {
    const response = await request.get('/api/admin/oripas')
    expect(response.status()).toBe(401)
  })
})

test.describe('管理者によるオリパ作成から公開まで', () => {
  test('在庫登録 → オリパ作成 → 景品割当 → 公開 → 公開一覧に出る', async ({ page }) => {
    test.slow()

    const suffix = uniqueSuffix()
    const inventoryCode = `E2E-${suffix}`.toUpperCase()
    const slug = `e2e-oripa-${suffix}`.toLowerCase()

    await login(page, 'admin@example.test')
    await expect(page).toHaveURL(/\/mypage/)

    // --- 1. 在庫を登録する ---
    await page.goto('/admin/inventories/new')
    await page.getByLabel('在庫コード').fill(inventoryCode)
    await page.getByLabel('タイトル（架空名）').fill('ルミナ・クロニクル')
    await page.getByLabel('カード名（架空名）').fill(`E2E 架空カード ${suffix}`)
    await page.getByLabel('レアリティ').fill('SR')
    await page.getByLabel('交換ポイント').fill('12000')
    await page.getByRole('button', { name: '登録する' }).click()

    await expect(page).toHaveURL(/\/admin\/inventories\/[^/]+$/)
    await expect(page.getByText(inventoryCode)).toBeVisible()

    // --- 2. オリパの下書きを作る（総口数 10 / S 賞 1・B 賞 9） ---
    await page.goto('/admin/oripas/new')
    await page.getByLabel('スラッグ（URL）').fill(slug)
    await page.getByLabel('名称').fill(`E2E テストオリパ ${suffix}`)
    await page.getByLabel('1 口価格（ポイント）').fill('300')
    await page.getByLabel('総口数').fill('10')

    const start = new Date(Date.now() - 60 * 60 * 1000)
    const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await page.getByLabel('販売開始日時').fill(toLocalInput(start))
    await page.getByLabel('販売終了日時').fill(toLocalInput(end))

    // 既定のランクは 3 つ（1 / 9 / 90）。C 賞相当を削って 1 + 9 = 10 にする。
    await page.getByRole('button', { name: '削除' }).nth(2).click()
    await expect(page.getByText('ランク口数の合計: 10 / 総口数: 10（一致）')).toBeVisible()

    await page.getByRole('button', { name: '下書きを作成する' }).click()
    await expect(page).toHaveURL(/\/admin\/oripas\/[^/]+$/)
    await expect(page.getByText('下書き', { exact: true })).toBeVisible()

    // この時点では公開条件を満たしていない（スロット未生成）
    await expect(page.getByText(/生成済みスロット数（0）/)).toBeVisible()

    // --- 3. 景品を割り当てる ---
    const sFieldset = page.getByRole('group').filter({ hasText: 'S賞（S）' })
    await sFieldset.getByRole('checkbox').first().check()

    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: 'スロットを生成する' }).click()

    await expect(page.getByText(/10 件のスロットを生成しました/)).toBeVisible()

    // --- 4. 公開する ---
    await page.reload()
    await expect(page.getByText('すべての公開条件を満たしています。')).toBeVisible()

    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '公開する' }).click()

    await expect(page.getByText('公開しました。')).toBeVisible()
    await page.reload()
    await expect(page.getByText('販売中', { exact: true })).toBeVisible()
    await expect(page.getByText('公正性の記録（コミット＆リビール）')).toBeVisible()

    // 公開後は割当フォームが消えている（構成を変えられない）
    await expect(page.getByRole('button', { name: 'スロットを生成する' })).toHaveCount(0)

    // --- 5. ユーザー向け一覧に出る ---
    await page.goto(`/oripas/${slug}`)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      `E2E テストオリパ ${suffix}`,
    )
    const sRow = page.getByRole('row').filter({ hasText: 'S賞' })
    await expect(sRow).toContainText('10.000%')
  })

  test('公開済みオリパを停止すると、ユーザー側に停止中と表示される', async ({ page }) => {
    await login(page, 'admin@example.test')
    // ログインの完了を待たずに遷移すると、セッション確立前のアクセスになってしまう
    await expect(page).toHaveURL(/\/mypage/)

    await page.goto('/admin/oripas?q=sample-light-01')
    await page.getByRole('link', { name: 'サンプル・ライトオリパ' }).click()
    await expect(page).toHaveURL(/\/admin\/oripas\/[^/]+$/)

    await page.getByLabel('理由').fill('E2E テストによる一時停止')
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '販売を停止する' }).click()
    await expect(page.getByText('販売を停止しました。')).toBeVisible()

    await page.goto('/oripas/sample-light-01')
    await expect(page.getByText('このオリパは現在販売を停止しています')).toBeVisible()

    // 後続のテストに影響しないよう、必ず元へ戻す
    await page.goBack()
    await page.reload()
    await page.getByLabel('理由').fill('E2E テストの後片付け')
    await page.getByRole('button', { name: '販売を再開する' }).click()
    await expect(page.getByText('販売を再開しました。')).toBeVisible()
  })
})

/** datetime-local が読める "YYYY-MM-DDTHH:mm"（ブラウザのローカル時刻 = JST） */
function toLocalInput(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000)
  return jst.toISOString().slice(0, 16)
}
