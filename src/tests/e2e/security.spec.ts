import { expect, test, type Page } from '@playwright/test'

/**
 * 監査ログ・アップロード・セキュリティヘッダの E2E（Phase 8）。
 *
 * ここで見たいのは「防御が実際に効いているか」であって、
 * 防御コードが存在するかではない。
 * 偽装した画像、パス traversal、権限の無いアクセスを実際に投げて、
 * 拒否されることを確かめる。
 */

const ADMIN_EMAIL = 'admin@example.test'
const ADMIN_PASSWORD = 'TestPassword123!'
const USER_PASSWORD = 'E2eSecurityPass1'

function uniqueEmail(): string {
  return `e2e-sec-${Date.now()}-${Math.floor(Math.random() * 10_000)}@example.test`
}

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL)
  await page.getByLabel('パスワード').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'ログイン' }).click()
  await expect(page).toHaveURL(/\/mypage/)
}

async function signupAndLogin(page: Page): Promise<string> {
  const email = uniqueEmail()
  await page.goto('/signup')
  await page.getByLabel('表示名').fill('セキュリティ検証')
  await page.getByLabel('メールアドレス').fill(email)
  await page.getByLabel('パスワード').fill(USER_PASSWORD)
  await page.getByText('利用規約とプライバシーポリシーに同意します').click()
  await page.getByRole('button', { name: '登録する' }).click()
  await expect(page).toHaveURL(/\/mypage/, { timeout: 15_000 })
  return email
}

/** 最小構成の PNG（ヘッダだけあれば種類判定は通る） */
function pngBytes(): Buffer {
  const bytes = Buffer.alloc(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
}

test.describe('監査ログ', () => {
  test('一般ユーザーは監査ログへ入れない', async ({ page }) => {
    await signupAndLogin(page)

    await page.goto('/admin/audit-logs')
    await expect(page).not.toHaveURL(/\/admin/)
  })

  test('未ログインで監査ログ API を叩くと 401 になる', async ({ request }) => {
    const response = await request.get('/api/admin/audit-logs')
    expect(response.status()).toBe(401)
  })

  test('管理者は参照でき、書き換える導線が存在しない', async ({ page }) => {
    await loginAsAdmin(page)

    await page.goto('/admin/audit-logs')
    await expect(page.getByRole('heading', { name: '監査ログ', level: 1 })).toBeVisible()
    await expect(page.getByText(/参照専用です/)).toBeVisible()

    // 削除・編集のボタンはどこにも無い
    await expect(page.getByRole('button', { name: /削除/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /編集/ })).toHaveCount(0)
  })

  test('監査ログの書き込み API は存在しない', async ({ page }) => {
    await loginAsAdmin(page)

    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const response = await page.request.fetch('/api/admin/audit-logs', {
        method,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: { action: 'FAKE' },
      })
      // 405（メソッド未定義）を期待する。200 系が返ってはならない。
      expect(response.ok()).toBe(false)
    }
  })

  test('日付で絞り込める', async ({ page }) => {
    await loginAsAdmin(page)

    // 1970 年には何も無い
    await page.goto('/admin/audit-logs?from=1970-01-01&to=1970-01-02')
    await expect(page.getByText('該当する記録がありません。')).toBeVisible()
  })

  test('不正な検索条件でも落ちず、既定の条件で表示する', async ({ page }) => {
    await loginAsAdmin(page)

    const response = await page.goto('/admin/audit-logs?from=not-a-date')
    expect(response?.status()).toBe(200)
    await expect(page.getByText('検索条件が不正です。')).toBeVisible()
  })

  test('パスワードハッシュが画面に出ない', async ({ page }) => {
    await loginAsAdmin(page)

    const response = await page.goto('/admin/audit-logs')
    const html = (await response?.text()) ?? ''

    expect(html).not.toContain('$argon2')
    expect(html).not.toContain('passwordHash":"$')
  })
})

test.describe('画像アップロード', () => {
  test('一般ユーザーはアップロードできない', async ({ page }) => {
    await signupAndLogin(page)

    const response = await page.request.post('/api/admin/uploads', {
      multipart: {
        file: { name: 'a.png', mimeType: 'image/png', buffer: pngBytes() },
      },
    })
    expect(response.status()).toBe(403)
  })

  test('管理者は PNG をアップロードでき、配信される', async ({ page }) => {
    test.slow()
    await loginAsAdmin(page)

    const response = await page.request.post('/api/admin/uploads', {
      multipart: {
        file: { name: 'card.png', mimeType: 'image/png', buffer: pngBytes() },
      },
    })
    expect(response.ok()).toBe(true)

    const body = await response.json()
    expect(body.data.imageKey).toMatch(/^upload:[A-Za-z0-9_-]+\.png$/)
    expect(body.data.contentType).toBe('image/png')

    // 配信側は Content-Type を保存済みバイト列から決め、推測を禁じる
    const name = body.data.imageKey.replace('upload:', '')
    const served = await page.request.get(`/api/uploads/${name}`)
    expect(served.ok()).toBe(true)
    expect(served.headers()['content-type']).toBe('image/png')
    expect(served.headers()['x-content-type-options']).toBe('nosniff')
  })

  test('image/png を名乗るスクリプトを拒否する（Content-Type を信用しない）', async ({
    page,
  }) => {
    test.slow()
    await loginAsAdmin(page)

    const response = await page.request.post('/api/admin/uploads', {
      multipart: {
        file: {
          name: 'evil.png',
          mimeType: 'image/png',
          buffer: Buffer.from('<?php system($_GET["c"]); ?>'),
        },
      },
    })

    expect(response.status()).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
  })

  test('SVG を拒否する（スクリプトを埋め込めるため）', async ({ page }) => {
    test.slow()
    await loginAsAdmin(page)

    const response = await page.request.post('/api/admin/uploads', {
      multipart: {
        file: {
          name: 'x.svg',
          mimeType: 'image/svg+xml',
          buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
        },
      },
    })

    expect(response.status()).toBe(400)
  })

  test('上限を超える画像を拒否する', async ({ page }) => {
    test.slow()
    await loginAsAdmin(page)

    const tooBig = Buffer.alloc(6 * 1024 * 1024)
    tooBig.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)

    const response = await page.request.post('/api/admin/uploads', {
      multipart: {
        file: { name: 'big.png', mimeType: 'image/png', buffer: tooBig },
      },
    })

    expect(response.status()).toBe(400)
  })

  test('パス traversal を拒否する', async ({ request }) => {
    for (const name of [
      '..%2F..%2F..%2Fetc%2Fpasswd',
      '....%2F%2Fetc%2Fpasswd',
      '.env',
      'index.html',
    ]) {
      const response = await request.get(`/api/uploads/${name}`)
      expect(response.status()).toBe(404)
    }
  })

  test('存在しない保存名は 404 になる（有無を推測させない）', async ({ request }) => {
    const response = await request.get('/api/uploads/abcdefghijklmnopqrst.png')
    expect(response.status()).toBe(404)
  })
})

test.describe('セキュリティヘッダ', () => {
  test('主要なヘッダが付いている', async ({ request }) => {
    const response = await request.get('/')
    const headers = response.headers()

    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    // クローズドテスト中は検索エンジンに拾わせない
    expect(headers['x-robots-tag']).toContain('noindex')
  })

  test('サーバー実装を名乗らない', async ({ request }) => {
    const response = await request.get('/')
    expect(response.headers()['x-powered-by']).toBeUndefined()
  })

  test('エラー時に内部情報を返さない', async ({ request }) => {
    const response = await request.get('/api/oripas/does-not-exist-9999')
    expect(response.status()).toBe(404)

    const text = await response.text()
    expect(text).not.toContain('at ')
    expect(text).not.toContain('node_modules')
    expect(text).not.toContain('prisma')
  })
})
