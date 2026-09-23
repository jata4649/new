import { expect, test, type Page } from '@playwright/test'

/**
 * 演出とポイント交換の E2E（Phase 6）。
 *
 * 前提: `pnpm db:seed` 済みであること。
 *
 * 引くのは E2E 専用オリパ（`e2e-draw-pool`・3,000 口・1 口 100 P）。
 * 表示確認用の sample-* を使うと、何度か流すうちに完売して
 * 全テストが落ちてしまうため、消費してよい専用プールを分けている。
 * ユーザーは毎回新規登録し、ポイントもその場で取得する。
 */

const PASSWORD = 'E2ePrizePassword1'
const TARGET_SLUG = 'e2e-draw-pool'

function uniqueEmail(): string {
  return `e2e-prize-${Date.now()}-${Math.floor(Math.random() * 10_000)}@example.test`
}

async function signupAndLogin(page: Page): Promise<string> {
  const email = uniqueEmail()

  await page.goto('/signup')
  await page.getByLabel('表示名').fill('当選商品検証')
  await page.getByLabel('メールアドレス').fill(email)
  await page.getByLabel('パスワード').fill(PASSWORD)
  await page.getByText('利用規約とプライバシーポリシーに同意します').click()
  await page.getByRole('button', { name: '登録する' }).click()

  await expect(page).toHaveURL(/\/mypage/, { timeout: 15_000 })
  return email
}

async function chargePoints(page: Page, amountYen: 500 | 1_000 | 3_000): Promise<void> {
  await page.goto('/mypage/points/purchase')
  await page.getByLabel('金額').selectOption(String(amountYen))
  await page.getByRole('button', { name: 'テスト決済を作成' }).click()
  await page.getByRole('button', { name: '決済成功にする' }).click()
  await expect(page.getByText(/ポイントを付与しました/)).toBeVisible()
}

/** 1 回引いて演出を最後まで進め、結果画面まで到達する */
async function drawOnceThroughEffect(page: Page): Promise<void> {
  await page.goto(`/oripas/${TARGET_SLUG}/draw`)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '1 回引く' }).click()

  // 演出が出る
  const effect = page.getByRole('dialog', { name: '抽選演出' })
  await expect(effect).toBeVisible()
  await effect.getByRole('button', { name: /スキップ|結果を見る/ }).click()
  await effect.getByRole('button', { name: '結果を見る' }).click()

  await expect(page).toHaveURL(/\/draws\/[^/]+$/)
}

test.describe('ガチャ演出', () => {
  test('抽選すると演出が出て、スキップしてから結果へ進める', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)

    await page.goto(`/oripas/${TARGET_SLUG}/draw`)
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '10 連で引く' }).click()

    const effect = page.getByRole('dialog', { name: '抽選演出' })
    await expect(effect).toBeVisible()

    // スキップすると 10 件すべてが表示される
    await effect.getByRole('button', { name: 'スキップ' }).click()
    await expect(effect.getByText('10 件すべて表示しました')).toBeVisible()
    await expect(effect.getByRole('listitem')).toHaveCount(10)

    await effect.getByRole('button', { name: '結果を見る' }).click()
    await expect(page).toHaveURL(/\/draws\/[^/]+$/)
    await expect(page.getByRole('heading', { name: '抽選結果', level: 1 })).toBeVisible()
  })

  test('Esc キーでも演出をスキップできる', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)

    await page.goto(`/oripas/${TARGET_SLUG}/draw`)
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '1 回引く' }).click()

    const effect = page.getByRole('dialog', { name: '抽選演出' })
    await expect(effect).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(effect.getByText('1 件すべて表示しました')).toBeVisible()
  })

  test('音の ON/OFF を切り替えられ、既定はオフ', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)

    await page.goto(`/oripas/${TARGET_SLUG}/draw`)
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '1 回引く' }).click()

    const effect = page.getByRole('dialog', { name: '抽選演出' })
    const soundButton = effect.getByRole('button', { name: /音/ })

    // 既定はオフ（不意に音が鳴らない）
    await expect(soundButton).toHaveAttribute('aria-pressed', 'false')
    await soundButton.click()
    await expect(soundButton).toHaveAttribute('aria-pressed', 'true')
  })

  test('演出中に閉じても結果は失われない', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)

    await page.goto(`/oripas/${TARGET_SLUG}/draw`)
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '1 回引く' }).click()
    await expect(page.getByRole('dialog', { name: '抽選演出' })).toBeVisible()

    // 演出の途中で別の画面へ移動する（＝ブラウザを閉じたのと同じ状況）
    await page.goto('/mypage/draws')
    await expect(page.getByRole('link', { name: 'E2E テスト用オリパ（大容量）' })).toBeVisible()
    await expect(page.getByText('まだ抽選していません。')).toHaveCount(0)
  })

  test('動きを減らす設定では溜めを作らず即座に全件表示する', async ({ browser }) => {
    test.slow()

    const context = await browser.newContext({ reducedMotion: 'reduce' })
    const page = await context.newPage()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)

    await page.goto(`/oripas/${TARGET_SLUG}/draw`)
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '10 連で引く' }).click()

    const effect = page.getByRole('dialog', { name: '抽選演出' })
    // 溜めが無いので、すぐに全件表示になる
    await expect(effect.getByText('10 件すべて表示しました')).toBeVisible({ timeout: 2_000 })

    await context.close()
  })
})

test.describe('ポイント交換', () => {
  test('当選商品を交換するとポイントが増え、状態が変わる', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)
    await drawOnceThroughEffect(page)

    await page.goto('/mypage/prizes')
    await expect(page.getByRole('heading', { name: '当選商品', level: 1 })).toBeVisible()
    await expect(page.getByText('未選択の商品が 1 件あります。')).toBeVisible()

    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: /P へ交換$/ }).click()

    await expect(page.getByText(/P を付与しました/)).toBeVisible()
    await page.reload()
    // 絞り込みの <option> にも同じ文字列があるため、一覧の中に限定して探す
    await expect(page.getByRole('listitem').getByText('ポイント交換済み')).toBeVisible()
    // 未選択が無くなったので案内も消える
    await expect(page.getByText(/未選択の商品が/)).toHaveCount(0)
  })

  test('確認ダイアログでキャンセルすると交換されない', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)
    await drawOnceThroughEffect(page)

    await page.goto('/mypage/prizes')
    page.once('dialog', (dialog) => void dialog.dismiss())
    await page.getByRole('button', { name: /P へ交換$/ }).click()

    await expect(page.getByText(/P を付与しました/)).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('listitem').getByText('未選択', { exact: true })).toBeVisible()
  })

  test('取消できない旨が画面に表示されている', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)
    await drawOnceThroughEffect(page)

    await page.goto('/mypage/prizes')
    await expect(page.getByText('交換すると取り消せません。')).toBeVisible()
  })
})

test.describe('交換 API の防御', () => {
  test('未ログインでは交換できない', async ({ request }) => {
    const response = await request.post('/api/prizes/any-id/exchange', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { confirm: true },
    })
    expect(response.status()).toBe(401)
  })

  test('confirm が無いと拒否される（取消不可の操作を既定で通さない）', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)
    await drawOnceThroughEffect(page)

    const prizes = await page.request.get('/api/me/prizes')
    const prizeId = (await prizes.json()).data.items[0].id

    const response = await page.request.post(`/api/prizes/${prizeId}/exchange`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: {},
    })
    expect(response.status()).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
  })

  test('2 回目の交換は 409 になり、ポイントは 1 回ぶんだけ増える', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)
    await drawOnceThroughEffect(page)

    const prizes = await page.request.get('/api/me/prizes')
    const prize = (await prizes.json()).data.items[0]

    const before = await page.request.get('/api/me/points')
    const beforeTotal = (await before.json()).data.spendable.total

    const first = await page.request.post(`/api/prizes/${prize.id}/exchange`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { confirm: true },
    })
    expect(first.ok()).toBe(true)

    // 別の冪等性キーで同じ商品を交換しようとする
    const second = await page.request.post(`/api/prizes/${prize.id}/exchange`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { confirm: true },
    })
    expect(second.status()).toBe(409)
    expect((await second.json()).error.code).toBe('PRIZE_NOT_UNDECIDED')

    const after = await page.request.get('/api/me/points')
    const afterTotal = (await after.json()).data.spendable.total
    expect(afterTotal).toBe(beforeTotal + prize.exchangePoints)
  })

  test('同じ冪等性キーの再送はリプレイになる', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)
    await drawOnceThroughEffect(page)

    const prizes = await page.request.get('/api/me/prizes')
    const prizeId = (await prizes.json()).data.items[0].id

    const key = crypto.randomUUID()
    const first = await page.request.post(`/api/prizes/${prizeId}/exchange`, {
      headers: { 'Idempotency-Key': key },
      data: { confirm: true },
    })
    const second = await page.request.post(`/api/prizes/${prizeId}/exchange`, {
      headers: { 'Idempotency-Key': key },
      data: { confirm: true },
    })

    expect(first.ok()).toBe(true)
    expect(second.ok()).toBe(true)
    expect(first.headers()['idempotency-replayed']).toBe('false')
    expect(second.headers()['idempotency-replayed']).toBe('true')
  })

  test('他人の当選商品は交換できない', async ({ page, browser }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)
    await drawOnceThroughEffect(page)

    const prizes = await page.request.get('/api/me/prizes')
    const prizeId = (await prizes.json()).data.items[0].id

    const otherContext = await browser.newContext()
    const otherPage = await otherContext.newPage()
    await signupAndLogin(otherPage)

    const response = await otherPage.request.post(`/api/prizes/${prizeId}/exchange`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { confirm: true },
    })
    expect(response.status()).toBe(404)

    await otherContext.close()
  })

  test('当選商品の一覧は本人のものだけを返す', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)
    await drawOnceThroughEffect(page)

    const response = await page.request.get('/api/me/prizes')
    const body = await response.json()
    expect(body.data.total).toBe(1)
    expect(body.data.undecidedTotal).toBe(1)
  })
})
