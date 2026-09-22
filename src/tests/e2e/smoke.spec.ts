import { expect, test } from '@playwright/test'

/**
 * Phase 1 のスモークテスト。
 * 「アプリが起動し、DB へ到達でき、クローズドガードが効いている」ことだけを確認する。
 * 業務シナリオの E2E は Phase 2 以降で追加する。
 */

test('トップページが表示される', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('テスト環境')
})

test('ヘルスチェックが DB 到達性を返す', async ({ request }) => {
  const response = await request.get('/api/health')
  expect(response.ok()).toBe(true)

  const body = await response.json()
  expect(body.success).toBe(true)
  expect(body.data.status).toBe('ok')
  expect(body.data.database).toBe(true)
})

test('プレースホルダー画像が SVG として返る（実在素材を使わない）', async ({ request }) => {
  const response = await request.get(
    `/api/placeholder/${encodeURIComponent('placeholder:SR:210:front')}`,
  )
  expect(response.ok()).toBe(true)
  expect(response.headers()['content-type']).toContain('image/svg+xml')
})

test('不正なプレースホルダーキーは 404 を返す（SVG への値の埋め込みを防ぐ）', async ({
  request,
}) => {
  const response = await request.get(
    `/api/placeholder/${encodeURIComponent('placeholder:<script>:210:front')}`,
  )
  expect(response.status()).toBe(404)
})

test('Basic 認証なしではサイトへアクセスできない（クローズドテスト）', async ({ baseURL }) => {
  test.skip(process.env.SITE_ACCESS_MODE === 'public', 'public モードでは適用されない')

  // Playwright の request コンテキストは設定の httpCredentials を引き継いでしまうため、
  // 資格情報を一切持たない素の fetch で確認する。
  const response = await fetch(new URL('/', baseURL), { redirect: 'manual' })
  expect(response.status).toBe(401)
  expect(response.headers.get('www-authenticate')).toContain('Basic')
})
