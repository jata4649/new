import { expect, test, type Page } from '@playwright/test'

/**
 * 抽選の E2E（Phase 5）。
 *
 * 前提: `pnpm db:seed` 済みであること。
 *
 * 引くのは E2E 専用オリパ（`e2e-draw-pool`・3,000 口・1 口 100 P）。
 * 表示確認用の sample-* を使うと、何度か流すうちに完売して
 * 全テストが「残り口数が足りません」で落ちてしまう。
 * 専用プールでもいずれ枯れるので、その場合は `pnpm db:reset` で作り直す。
 *
 * ユーザーは毎回新規登録し、ポイントもその場で取得する
 * （seed ユーザーを共有すると、先に実行したテストの残高に影響される）。
 *
 * API を直接叩くテストでは `page.request` を使う。
 * これはブラウザコンテキストと Cookie を共有するので、
 * ログイン状態のままリクエストを送れる。
 */

const PASSWORD = 'E2eDrawPassword1'
const TARGET_SLUG = 'e2e-draw-pool'
/** E2E 専用オリパの 1 口価格 */
const UNIT_PRICE = 100

function uniqueEmail(): string {
  return `e2e-draw-${Date.now()}-${Math.floor(Math.random() * 10_000)}@example.test`
}

async function signupAndLogin(page: Page): Promise<string> {
  const email = uniqueEmail()

  await page.goto('/signup')
  await page.getByLabel('表示名').fill('抽選検証')
  await page.getByLabel('メールアドレス').fill(email)
  await page.getByLabel('パスワード').fill(PASSWORD)
  await page.getByText('利用規約とプライバシーポリシーに同意します').click()
  await page.getByRole('button', { name: '登録する' }).click()

  await expect(page).toHaveURL(/\/mypage/, { timeout: 15_000 })
  return email
}

/** テスト決済を成立させてポイントを得る（選べる金額は固定） */
async function chargePoints(page: Page, amountYen: 500 | 1_000 | 3_000): Promise<void> {
  await page.goto('/mypage/points/purchase')
  await page.getByLabel('金額').selectOption(String(amountYen))
  await page.getByRole('button', { name: 'テスト決済を作成' }).click()
  await page.getByRole('button', { name: '決済成功にする' }).click()
  await expect(page.getByText(/ポイントを付与しました/)).toBeVisible()
}

test.describe('抽選の実行', () => {
  test('1 回引くと結果画面に 1 件表示され、ポイントが減る', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)

    await page.goto(`/oripas/${TARGET_SLUG}/draw`)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'E2E テスト用オリパ（大容量）',
    )

    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '1 回引く' }).click()

    await expect(page).toHaveURL(/\/draws\/[^/]+$/)
    await expect(page.getByRole('heading', { name: '抽選結果', level: 1 })).toBeVisible()
    await expect(page.getByRole('listitem')).toHaveCount(1)

    await page.goto('/mypage/points')
    await expect(page.getByText(`${1_000 - UNIT_PRICE} P`).first()).toBeVisible()
  })

  test('10 連で引くと結果が 10 件並ぶ', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 3_000)

    await page.goto(`/oripas/${TARGET_SLUG}/draw`)

    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '10 連で引く' }).click()

    await expect(page).toHaveURL(/\/draws\/[^/]+$/)
    await expect(page.getByRole('listitem')).toHaveCount(10)
  })

  test('確認ダイアログでキャンセルすると抽選されない', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)

    await page.goto(`/oripas/${TARGET_SLUG}/draw`)

    page.once('dialog', (dialog) => void dialog.dismiss())
    await page.getByRole('button', { name: '1 回引く' }).click()

    // 画面遷移せず、履歴にも残らない
    await expect(page).toHaveURL(/\/draw$/)
    await page.goto('/mypage/draws')
    await expect(page.getByText('まだ抽選していません。')).toBeVisible()
  })

  test('リロードしても結果が失われず、履歴からも辿れる', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)

    await page.goto(`/oripas/${TARGET_SLUG}/draw`)
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '1 回引く' }).click()
    await expect(page).toHaveURL(/\/draws\/[^/]+$/)

    const resultUrl = page.url()
    await page.reload()
    await expect(page.getByRole('heading', { name: '抽選結果', level: 1 })).toBeVisible()

    await page.goto('/mypage/draws')
    await page.getByRole('link', { name: 'E2E テスト用オリパ（大容量）' }).first().click()
    // クリック直後は遷移が完了していないため、URL の一致を待って確認する
    await expect(page).toHaveURL(resultUrl)
    await expect(page.getByRole('heading', { name: '抽選結果', level: 1 })).toBeVisible()
  })

  test('ポイントが足りないと抽選ボタンが押せない', async ({ page }) => {
    await signupAndLogin(page)

    await page.goto(`/oripas/${TARGET_SLUG}/draw`)
    await expect(page.getByRole('button', { name: '1 回引く' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '10 連で引く' })).toBeDisabled()
  })
})

test.describe('抽選 API の防御', () => {
  test('未ログインでは抽選できない', async ({ request }) => {
    const response = await request.post(`/api/oripas/${TARGET_SLUG}/draw`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { drawCount: 1 },
    })
    expect(response.status()).toBe(401)
  })

  test('冪等性キーが無いと拒否される', async ({ page }) => {
    await signupAndLogin(page)

    const response = await page.request.post(`/api/oripas/${TARGET_SLUG}/draw`, {
      data: { drawCount: 1 },
    })
    expect(response.status()).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })

  test('許可されていない口数を拒否する', async ({ page }) => {
    await signupAndLogin(page)

    const response = await page.request.post(`/api/oripas/${TARGET_SLUG}/draw`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { drawCount: 3 },
    })
    expect(response.status()).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  test('slotId を指定しても無視され、当たりを狙い撃ちできない', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)

    // 当たりスロットを名指ししようとする
    const response = await page.request.post(`/api/oripas/${TARGET_SLUG}/draw`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { drawCount: 1, slotId: 'any-slot-id', tierCode: 'A', inventoryId: 'any' },
    })

    // リクエスト自体は通る（未知のキーは Zod が捨てる）が、指定は一切効かない
    expect(response.ok()).toBe(true)
    const body = await response.json()
    expect(body.data.drawCount).toBe(1)
    expect(body.data.prizes).toHaveLength(1)
  })

  test('同じ冪等性キーで 2 回送っても抽選は 1 回だけ', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)

    const key = crypto.randomUUID()
    const payload = { drawCount: 1 }

    const first = await page.request.post(`/api/oripas/${TARGET_SLUG}/draw`, {
      headers: { 'Idempotency-Key': key },
      data: payload,
    })
    const second = await page.request.post(`/api/oripas/${TARGET_SLUG}/draw`, {
      headers: { 'Idempotency-Key': key },
      data: payload,
    })

    expect(first.ok()).toBe(true)
    expect(second.ok()).toBe(true)
    expect(first.headers()['idempotency-replayed']).toBe('false')
    expect(second.headers()['idempotency-replayed']).toBe('true')

    const firstBody = await first.json()
    const secondBody = await second.json()
    expect(secondBody.data.drawTransactionId).toBe(firstBody.data.drawTransactionId)

    const history = await page.request.get('/api/me/draws')
    expect((await history.json()).data.total).toBe(1)
  })

  test('他人の抽選結果は取得できない', async ({ page, browser }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)
    const drawResponse = await page.request.post(`/api/oripas/${TARGET_SLUG}/draw`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { drawCount: 1 },
    })
    const drawId = (await drawResponse.json()).data.drawTransactionId

    // 別のユーザーが ID を知っていても読めない
    const otherContext = await browser.newContext()
    const otherPage = await otherContext.newPage()
    await signupAndLogin(otherPage)

    const response = await otherPage.request.get(`/api/draws/${drawId}`)
    expect(response.status()).toBe(404)

    await otherContext.close()
  })

  test('抽選 API の応答に抽選順とスロット ID を含めない', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 1_000)

    const response = await page.request.post(`/api/oripas/${TARGET_SLUG}/draw`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { drawCount: 1 },
    })
    const text = await response.text()

    expect(text).not.toContain('drawOrder')
    expect(text).not.toContain('draw_order')
    expect(text).not.toContain('slotId')
    expect(text).not.toContain('slotOrderSeed')
  })

  test('販売前のオリパは抽選できない', async ({ page }) => {
    await signupAndLogin(page)

    const response = await page.request.post('/api/oripas/sample-scheduled-01/draw', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { drawCount: 1 },
    })
    expect(response.status()).toBe(409)
    expect((await response.json()).error.code).toBe('CAMPAIGN_NOT_ON_SALE')
  })

  test('完売したオリパは抽選できない', async ({ page }) => {
    await signupAndLogin(page)

    const response = await page.request.post('/api/oripas/sample-soldout-01/draw', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { drawCount: 1 },
    })
    expect(response.status()).toBe(409)
    expect((await response.json()).error.code).toBe('CAMPAIGN_NOT_ON_SALE')
  })
})

test.describe('管理画面の抽選履歴', () => {
  test('管理者は抽選履歴を見られるが、抽選順とスロット ID は出ない', async ({ page }) => {
    test.slow()

    // まず一般ユーザーが 1 回引く
    const email = await signupAndLogin(page)
    await chargePoints(page, 1_000)
    await page.goto(`/oripas/${TARGET_SLUG}/draw`)
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '1 回引く' }).click()
    await expect(page).toHaveURL(/\/draws\/[^/]+$/)

    // 管理者でログインし直して履歴を見る
    await page.goto('/login')
    await page.getByLabel('メールアドレス').fill('admin@example.test')
    await page.getByLabel('パスワード').fill('TestPassword123!')
    await page.getByRole('button', { name: 'ログイン' }).click()
    await expect(page).toHaveURL(/\/mypage/)

    const response = await page.goto(`/admin/draws?userEmail=${encodeURIComponent(email)}`)
    await expect(page.getByRole('heading', { name: '抽選履歴', level: 1 })).toBeVisible()
    await expect(page.getByText(email)).toBeVisible()

    const html = (await response?.text()) ?? ''
    expect(html).not.toContain('drawOrder')
    expect(html).not.toContain('draw_order')
    expect(html).not.toContain('slotOrderSeed')
  })

  test('一般ユーザーは管理画面の抽選履歴へ入れない', async ({ page }) => {
    await signupAndLogin(page)

    await page.goto('/admin/draws')
    await expect(page).not.toHaveURL(/\/admin/)
  })
})
