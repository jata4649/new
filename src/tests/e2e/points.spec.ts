import { expect, test, type Page } from '@playwright/test'

/**
 * ポイントとテスト決済の E2E（Phase 3）。
 *
 * 前提: `pnpm db:seed` 済み。パスワードは TestPassword123!
 *
 * 各テストは独立したユーザーを新規登録して使う。
 * seed ユーザーを共有すると、先に実行したテストの残高が影響してしまうため。
 */

const PASSWORD = 'E2ePointsPassword1'

async function signupAndLogin(page: Page): Promise<string> {
  const email = `e2e-points-${Date.now()}-${Math.floor(Math.random() * 10_000)}@example.test`

  await page.goto('/signup')
  await page.getByLabel('表示名').fill('ポイント検証')
  await page.getByLabel('メールアドレス').fill(email)
  await page.getByLabel('パスワード').fill(PASSWORD)
  await page.getByText('利用規約とプライバシーポリシーに同意します').click()
  await page.getByRole('button', { name: '登録する' }).click()

  await expect(page).toHaveURL(/\/mypage/, { timeout: 15_000 })
  return email
}

test('登録直後の残高は 0 ポイント', async ({ page }) => {
  await signupAndLogin(page)

  await page.goto('/mypage/points')
  await expect(page.getByRole('heading', { name: '保有ポイント' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '利用可能なポイント' })).toBeVisible()
  await expect(page.getByText('0 P').first()).toBeVisible()
})

test('テスト決済を作成しただけではポイントが付与されない', async ({ page }) => {
  await signupAndLogin(page)

  await page.goto('/mypage/points/purchase')
  await page.getByRole('button', { name: 'テスト決済を作成' }).click()

  await expect(page.getByText('この時点ではポイントは付与されません')).toBeVisible()

  await page.goto('/mypage/points')
  await expect(page.getByText('0 P').first()).toBeVisible()
})

test('決済を成功させるとポイントが付与され、履歴に残る', async ({ page }) => {
  await signupAndLogin(page)

  await page.goto('/mypage/points/purchase')
  await page.getByRole('button', { name: 'テスト決済を作成' }).click()
  await expect(page.getByText('テスト決済を作成しました')).toBeVisible()

  await page.getByRole('button', { name: '決済成功にする' }).click()
  await expect(page.getByText(/ポイントを付与しました/)).toBeVisible()

  await page.goto('/mypage/points')
  await expect(page.getByText('1,000 P').first()).toBeVisible()

  await page.goto('/mypage/points/history')
  await expect(page.getByRole('cell', { name: '購入' })).toBeVisible()
  await expect(page.getByText('+1,000')).toBeVisible()
})

test('決済を失敗させてもポイントは付与されない', async ({ page }) => {
  await signupAndLogin(page)

  await page.goto('/mypage/points/purchase')
  await page.getByRole('button', { name: 'テスト決済を作成' }).click()
  await page.getByRole('button', { name: '決済失敗にする' }).click()

  await expect(page.getByText(/ポイントは付与されていません/)).toBeVisible()

  await page.goto('/mypage/points')
  await expect(page.getByText('0 P').first()).toBeVisible()
})

test('同じ冪等性キーで 2 回送信してもポイントは 1 回だけ付与される', async ({ page }) => {
  await signupAndLogin(page)

  await page.goto('/mypage/points/purchase')
  await page.getByRole('button', { name: 'テスト決済を作成' }).click()
  await expect(page.getByText('テスト決済を作成しました')).toBeVisible()

  await page.getByRole('button', { name: '同じキーで 2 回送信する' }).click()
  await expect(page.getByText(/付与は 1 回だけ|2 回目は拒否/)).toBeVisible()

  await page.goto('/mypage/points')
  // 二重付与されていれば 2,000 P になる
  await expect(page.getByText('1,000 P').first()).toBeVisible()

  await page.goto('/mypage/points/history')
  const purchaseRows = page.getByRole('cell', { name: '購入' })
  await expect(purchaseRows).toHaveCount(1)
})

test('有効期限の内訳が表示される', async ({ page }) => {
  await signupAndLogin(page)

  await page.goto('/mypage/points/purchase')
  await page.getByRole('button', { name: 'テスト決済を作成' }).click()
  await page.getByRole('button', { name: '決済成功にする' }).click()
  await expect(page.getByText(/ポイントを付与しました/)).toBeVisible()

  await page.goto('/mypage/points')
  await expect(page.getByRole('heading', { name: '有効期限の内訳' })).toBeVisible()
  await expect(page.getByRole('cell', { name: '有償' })).toBeVisible()
  // 有償ポイントは 180 日で失効する
  await expect(page.getByText(/あと 17[0-9] 日|あと 180 日/)).toBeVisible()
})

test('ポイント API は未ログインで 401 を返す', async ({ request }) => {
  const response = await request.get('/api/me/points')
  expect(response.status()).toBe(401)
})

test('Webhook は署名が無ければ 401 を返す', async ({ request }) => {
  const response = await request.post('/api/webhooks/mock-payment', {
    data: {
      eventId: 'evt_no_signature',
      eventType: 'payment.updated',
      providerPaymentId: 'mock_pi_x',
      status: 'SUCCEEDED',
      occurredAt: new Date().toISOString(),
    },
  })

  expect(response.status()).toBe(401)
  const body = await response.json()
  expect(body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID')
})

test('管理者がポイントを調整でき、理由が履歴に残る', async ({ page, browser }) => {
  // 調整対象となるユーザーを作る
  const targetContext = await browser.newContext()
  const targetPage = await targetContext.newPage()
  const targetEmail = await signupAndLogin(targetPage)

  // 管理者としてログインし、対象ユーザーを探す
  await page.goto('/login')
  await page.getByLabel('メールアドレス').fill('admin@example.test')
  await page.getByLabel('パスワード').fill('TestPassword123!')
  await page.getByRole('button', { name: 'ログイン' }).click()
  await expect(page).toHaveURL(/\/mypage/)

  await page.goto(`/admin/users?q=${encodeURIComponent(targetEmail)}`)
  await page.getByRole('link', { name: 'ポイント検証' }).click()

  await expect(page.getByRole('heading', { name: 'ポイント調整' })).toBeVisible()

  // 「理由」の入力欄はポイント調整とステータス変更の 2 か所にあるため、
  // 対象のセクションに絞り込む
  const adjustmentSection = page.getByRole('region', { name: 'ポイント調整' })
  await adjustmentSection.getByLabel('増減するポイント数').fill('500')
  await adjustmentSection.getByLabel('理由').fill('問い合わせ対応による補填（E2E テスト）')

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('台帳と監査ログに記録されます')
    void dialog.accept()
  })
  await adjustmentSection.getByRole('button', { name: 'ポイントを調整する' }).click()

  await expect(page.getByText(/調整しました/)).toBeVisible()

  // 対象ユーザー側で残高と履歴を確認する
  await targetPage.goto('/mypage/points')
  await expect(targetPage.getByText('500 P').first()).toBeVisible()

  await targetPage.goto('/mypage/points/history')
  await expect(targetPage.getByRole('cell', { name: '調整' })).toBeVisible()
  await expect(targetPage.getByText('問い合わせ対応による補填（E2E テスト）')).toBeVisible()

  await targetContext.close()
})

test('一般ユーザーはポイント調整 API を呼べない', async ({ page, request }) => {
  await signupAndLogin(page)

  const cookies = await page.context().cookies()
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')

  const response = await request.post('/api/admin/users/any-id/point-adjustments', {
    headers: {
      cookie: cookieHeader,
      'Idempotency-Key': crypto.randomUUID(),
      origin: new URL(page.url()).origin,
    },
    data: { amount: 100_000, reason: '権限が無いユーザーからの調整試行' },
  })

  expect(response.status()).toBe(403)
  const body = await response.json()
  expect(body.error.code).toBe('FORBIDDEN')
})
