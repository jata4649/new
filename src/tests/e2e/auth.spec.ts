import { expect, test, type Page } from '@playwright/test'

/**
 * 認証フローの E2E（Phase 2）。
 *
 * 前提: `pnpm db:seed` 済みであること。
 *   admin@example.test / user1@example.test / user3@example.test（停止中）
 *   パスワードはいずれも TestPassword123!
 */

const PASSWORD = 'TestPassword123!'

async function login(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('メールアドレス').fill(email)
  await page.getByLabel('パスワード').fill(PASSWORD)
  await page.getByRole('button', { name: 'ログイン' }).click()
}

test('未ログインでマイページを開くとログイン画面へ送られる', async ({ page }) => {
  await page.goto('/mypage')
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible()
})

test('未ログインで管理画面を開くとログイン画面へ送られる', async ({ page }) => {
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/login/)
})

test('一般ユーザーがログインしてマイページを見られる', async ({ page }) => {
  await login(page, 'user1@example.test')

  await expect(page).toHaveURL(/\/mypage/)
  await expect(page.getByRole('heading', { name: 'マイページ' })).toBeVisible()
  await expect(page.getByText('保有ポイント')).toBeVisible()
})

test('一般ユーザーは管理画面へ入れない', async ({ page }) => {
  await login(page, 'user1@example.test')
  await expect(page).toHaveURL(/\/mypage/)

  await page.goto('/admin')
  // 管理画面の存在を隠すため、トップへ戻される
  await expect(page).not.toHaveURL(/\/admin/)
  await expect(page.getByRole('heading', { name: '管理画面' })).toHaveCount(0)
})

test('パスワードが違うとログインできず、理由を明かさない', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('メールアドレス').fill('user1@example.test')
  await page.getByLabel('パスワード').fill('WrongPassword12345')
  await page.getByRole('button', { name: 'ログイン' }).click()

  // Next.js のルートアナウンサーも role="alert" を持つため、テキストで特定する
  await expect(page.getByText('メールアドレスまたはパスワードが正しくありません')).toBeVisible()
  await expect(page).toHaveURL(/\/login/)
})

test('存在しないユーザーでも同じメッセージになる（アカウント列挙の防止）', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('メールアドレス').fill('nobody@example.test')
  await page.getByLabel('パスワード').fill(PASSWORD)
  await page.getByRole('button', { name: 'ログイン' }).click()

  await expect(page.getByText('メールアドレスまたはパスワードが正しくありません')).toBeVisible()
})

test('停止中のユーザーはログインできない', async ({ page }) => {
  await login(page, 'user3@example.test')

  await expect(page.getByText('メールアドレスまたはパスワードが正しくありません')).toBeVisible()
  await expect(page).toHaveURL(/\/login/)
})

test('管理者がログインして管理画面とユーザー一覧を見られる', async ({ page }) => {
  await login(page, 'admin@example.test')
  await expect(page).toHaveURL(/\/mypage/)

  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible()
  await expect(page.getByText('登録ユーザー数')).toBeVisible()

  await page.goto('/admin/users')
  await expect(page.getByRole('heading', { name: 'ユーザー管理' })).toBeVisible()
  await expect(page.getByText('admin@example.test')).toBeVisible()
})

test('ログアウトするとマイページへ入れなくなる', async ({ page }) => {
  await login(page, 'user1@example.test')
  await expect(page).toHaveURL(/\/mypage/)

  await page.getByRole('button', { name: 'ログアウト' }).click()
  await expect(page).toHaveURL('/')

  await page.goto('/mypage')
  await expect(page).toHaveURL(/\/login/)
})

test('/api/me は未ログインで 401 を返し、内部情報を含まない', async ({ request }) => {
  const response = await request.get('/api/me')

  expect(response.status()).toBe(401)
  const body = await response.json()
  expect(body.success).toBe(false)
  expect(body.error.code).toBe('UNAUTHENTICATED')
  // スタックトレース等が漏れていないこと
  expect(JSON.stringify(body)).not.toContain('at ')
  expect(body.error).not.toHaveProperty('stack')
})

test('管理 API は未ログインで 401 を返す', async ({ request }) => {
  const response = await request.get('/api/admin/users')
  expect(response.status()).toBe(401)
})

test('登録フォームは規約への同意がないと送信できない', async ({ page }) => {
  await page.goto('/signup')

  await page.getByLabel('表示名').fill('E2E テスト')
  await page.getByLabel('メールアドレス').fill(`e2e-${Date.now()}@example.test`)
  await page.getByLabel('パスワード').fill('E2eTestPassword1')
  await page.getByRole('button', { name: '登録する' }).click()

  await expect(page.getByText('利用規約への同意が必要です')).toBeVisible()
})

test('新規登録するとそのままログイン状態になる', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.test`

  await page.goto('/signup')
  await page.getByLabel('表示名').fill('E2E テスト')
  await page.getByLabel('メールアドレス').fill(email)
  await page.getByLabel('パスワード').fill('E2eTestPassword1')
  await page.getByText('利用規約とプライバシーポリシーに同意します').click()
  await page.getByRole('button', { name: '登録する' }).click()

  await expect(page).toHaveURL(/\/mypage/, { timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'マイページ' })).toBeVisible()
})
