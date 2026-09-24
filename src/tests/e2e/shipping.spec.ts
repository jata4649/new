import { expect, test, type Page } from '@playwright/test'

import { drawThroughEffect, SHIP_POOL_SLUG } from './support/draw-flow.ts'

/**
 * 配送先・発送申請・発送管理の E2E（Phase 7）。
 *
 * 前提: `pnpm db:seed` 済みであること。
 *
 * 引くのは発送 E2E 専用オリパ（`e2e-ship-pool`）。
 * 表示確認用の sample-* や `e2e-draw-pool` は景品が発送の対象外なので、
 * そちらを引くと発送申請の導線を一度も通れない。
 * このプールの景品は汎用景品なので、物理在庫を消費せず何度流しても枯れない。
 */

const PASSWORD = 'E2eShipPassword1'
const ADMIN_PASSWORD = 'TestPassword123!'

function uniqueEmail(): string {
  return `e2e-ship-${Date.now()}-${Math.floor(Math.random() * 10_000)}@example.test`
}

async function signupAndLogin(page: Page): Promise<string> {
  const email = uniqueEmail()

  await page.goto('/signup')
  await page.getByLabel('表示名').fill('発送検証')
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

async function registerAddress(page: Page, recipientName = '架空 太郎'): Promise<void> {
  await page.goto('/mypage/addresses')
  await page.getByLabel('宛名').fill(recipientName)
  await page.getByLabel('郵便番号').fill('1500001')
  await page.getByLabel('都道府県').selectOption('東京都')
  await page.getByLabel('市区町村').fill('渋谷区')
  await page.getByLabel('番地').fill('神南 1-2-3')
  await page.getByLabel('電話番号').fill('090-1234-5678')
  await page.getByRole('button', { name: '登録する' }).click()

  await expect(page.getByRole('listitem').getByText(recipientName).first()).toBeVisible()
}

/**
 * 発送できる当選商品を手に入れる。
 *
 * 発送専用プールの景品はすべて発送対象なので、1 回引けば必ず手に入る。
 * それでも念のため件数を確認し、0 件ならここで落とす
 * （seed が変わって「発送できない景品だけ」に戻ったことに気付けるように）。
 */
async function drawShippablePrizes(page: Page): Promise<void> {
  await drawThroughEffect(page, 10, { slug: SHIP_POOL_SLUG })

  const response = await page.request.get('/api/me/prizes?status=UNDECIDED&perPage=100')
  const body = await response.json()
  const shippable = body.data.items.filter((item: { shippable: boolean }) => item.shippable)
  expect(shippable.length).toBeGreaterThan(0)
}

test.describe('配送先', () => {
  test('登録すると一覧に出て、最初の 1 件は既定になる', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await registerAddress(page)

    await expect(page.getByRole('listitem').getByText('既定')).toBeVisible()
    await expect(page.getByText('〒150-0001 東京都渋谷区神南 1-2-3')).toBeVisible()
  })

  test('郵便番号と電話番号は書式が揃えられて保存される', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)

    await page.goto('/mypage/addresses')
    await page.getByLabel('宛名').fill('架空 次郎')
    await page.getByLabel('郵便番号').fill('1500001')
    await page.getByLabel('都道府県').selectOption('東京都')
    await page.getByLabel('市区町村').fill('渋谷区')
    await page.getByLabel('番地').fill('神南 1-2-3')
    await page.getByLabel('電話番号').fill('090-1234-5678')
    await page.getByRole('button', { name: '登録する' }).click()

    // ハイフン無しで入れた郵便番号にハイフンが入り、電話番号からは消える
    await expect(page.getByText('〒150-0001 東京都渋谷区神南 1-2-3')).toBeVisible()
    await expect(page.getByText('09012345678')).toBeVisible()
  })

  test('不正な郵便番号は登録できない', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)

    await page.goto('/mypage/addresses')
    await page.getByLabel('宛名').fill('架空 三郎')
    await page.getByLabel('郵便番号').fill('150')
    await page.getByLabel('都道府県').selectOption('東京都')
    await page.getByLabel('市区町村').fill('渋谷区')
    await page.getByLabel('番地').fill('神南 1-2-3')
    await page.getByLabel('電話番号').fill('09012345678')
    await page.getByRole('button', { name: '登録する' }).click()

    await expect(page.getByText('郵便番号は 7 桁の数字で入力してください')).toBeVisible()
  })

  test('2 件目を既定にすると、1 件目の既定が外れる', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await registerAddress(page, '架空 太郎')

    await page.getByLabel('宛名').fill('架空 花子')
    await page.getByLabel('郵便番号').fill('5300001')
    await page.getByLabel('都道府県').selectOption('大阪府')
    await page.getByLabel('市区町村').fill('大阪市北区')
    await page.getByLabel('番地').fill('梅田 1-1-1')
    await page.getByLabel('電話番号').fill('0612345678')
    await page.getByRole('button', { name: '登録する' }).click()

    await expect(page.getByRole('listitem').getByText('架空 花子')).toBeVisible()

    // 既定は常に 1 件だけ
    await expect(page.getByRole('listitem').getByText('既定', { exact: true })).toHaveCount(1)
  })
})

test.describe('発送申請', () => {
  test('配送先が無いと申請できず、登録へ案内される', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 3_000)
    await drawShippablePrizes(page)

    await page.goto('/mypage/prizes')
    await expect(page.getByText('発送申請には配送先の登録が必要です。')).toBeVisible()
    await expect(page.getByRole('link', { name: '配送先を登録する' })).toBeVisible()
  })

  test('申請すると発送申請一覧に出て、商品は交換できなくなる', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 3_000)
    await drawShippablePrizes(page)
    await registerAddress(page)

    await page.goto('/mypage/prizes')
    const panel = page.getByRole('group').filter({ hasText: '発送する商品' })
    await panel.getByRole('checkbox').first().check()

    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: /点の発送を申請する$/ }).click()

    await expect(page).toHaveURL(/\/mypage\/shipments$/)
    await expect(page.getByRole('heading', { name: '発送申請', level: 1 })).toBeVisible()
    await expect(page.getByRole('listitem').getByText('申請受付').first()).toBeVisible()
    await expect(page.getByText('架空 太郎 / 〒150-0001 東京都渋谷区神南 1-2-3')).toBeVisible()

    // 申請した商品は当選商品一覧で「発送申請中」になり、交換ボタンが消える
    await page.goto('/mypage/prizes?status=SHIPPING_REQUESTED')
    await expect(page.getByRole('listitem').getByText('発送申請中').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /P へ交換$/ })).toHaveCount(0)
  })

  test('取り消すと商品が未選択へ戻る', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 3_000)
    await drawShippablePrizes(page)
    await registerAddress(page)

    await page.goto('/mypage/prizes')
    const panel = page.getByRole('group').filter({ hasText: '発送する商品' })
    await panel.getByRole('checkbox').first().check()
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: /点の発送を申請する$/ }).click()
    await expect(page).toHaveURL(/\/mypage\/shipments$/)

    await page.getByLabel('取消しの理由').fill('住所を間違えたため')
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '発送申請を取り消す' }).click()

    await expect(page.getByRole('listitem').getByText('取消済み').first()).toBeVisible()
    await expect(page.getByText('取消し理由: 住所を間違えたため')).toBeVisible()

    // 商品は未選択へ戻り、交換もできる
    await page.goto('/mypage/prizes?status=UNDECIDED')
    await expect(page.getByRole('button', { name: /P へ交換$/ }).first()).toBeVisible()
  })

  test('確認ダイアログでキャンセルすると申請されない', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 3_000)
    await drawShippablePrizes(page)
    await registerAddress(page)

    await page.goto('/mypage/prizes')
    const panel = page.getByRole('group').filter({ hasText: '発送する商品' })
    await panel.getByRole('checkbox').first().check()

    page.once('dialog', (dialog) => void dialog.dismiss())
    await page.getByRole('button', { name: /点の発送を申請する$/ }).click()

    await page.goto('/mypage/shipments')
    await expect(page.getByText('まだ発送申請はありません。')).toBeVisible()
  })
})

test.describe('発送 API の防御', () => {
  test('未ログインでは申請できない', async ({ request }) => {
    const response = await request.post('/api/shipping-requests', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { prizeIds: ['x'], addressId: 'y', confirm: true },
    })
    expect(response.status()).toBe(401)
  })

  test('confirm が無いと拒否される', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)

    const response = await page.request.post('/api/shipping-requests', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { prizeIds: ['x'], addressId: 'y' },
    })
    expect(response.status()).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
  })

  test('他人の当選商品は申請できない', async ({ page, browser }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 3_000)
    await drawShippablePrizes(page)

    const prizes = await page.request.get('/api/me/prizes?status=UNDECIDED&perPage=100')
    const prizeId = (await prizes.json()).data.items[0].id

    const otherContext = await browser.newContext()
    const otherPage = await otherContext.newPage()
    await signupAndLogin(otherPage)
    await registerAddress(otherPage)

    const addresses = await otherPage.request.get('/api/me/addresses')
    const addressId = (await addresses.json()).data.items[0].id

    const response = await otherPage.request.post('/api/shipping-requests', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { prizeIds: [prizeId], addressId, confirm: true },
    })
    expect(response.status()).toBe(404)

    await otherContext.close()
  })

  test('同じ冪等性キーの再送はリプレイになり、申請は 1 件だけ', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)
    await chargePoints(page, 3_000)
    await drawShippablePrizes(page)
    await registerAddress(page)

    const prizes = await page.request.get('/api/me/prizes?status=UNDECIDED&perPage=100')
    const shippable = (await prizes.json()).data.items.filter(
      (item: { shippable: boolean }) => item.shippable,
    )
    const addresses = await page.request.get('/api/me/addresses')
    const addressId = (await addresses.json()).data.items[0].id

    const key = crypto.randomUUID()
    const payload = { prizeIds: [shippable[0].id], addressId, confirm: true }

    const first = await page.request.post('/api/shipping-requests', {
      headers: { 'Idempotency-Key': key },
      data: payload,
    })
    const second = await page.request.post('/api/shipping-requests', {
      headers: { 'Idempotency-Key': key },
      data: payload,
    })

    expect(first.ok()).toBe(true)
    expect(second.ok()).toBe(true)
    expect(first.headers()['idempotency-replayed']).toBe('false')
    expect(second.headers()['idempotency-replayed']).toBe('true')

    const list = await page.request.get('/api/me/shipments')
    expect((await list.json()).data.total).toBe(1)
  })

  test('他人の配送先は読めない', async ({ page, browser }) => {
    test.slow()

    await signupAndLogin(page)
    await registerAddress(page)

    const otherContext = await browser.newContext()
    const otherPage = await otherContext.newPage()
    await signupAndLogin(otherPage)

    const response = await otherPage.request.get('/api/me/addresses')
    expect((await response.json()).data.items).toHaveLength(0)

    await otherContext.close()
  })

  test('発送申請の一覧は本人のものだけを返す', async ({ page }) => {
    test.slow()

    await signupAndLogin(page)

    const response = await page.request.get('/api/me/shipments')
    expect((await response.json()).data.total).toBe(0)
  })
})

test.describe('発送管理（管理画面）', () => {
  test('一般ユーザーは発送管理へ入れない', async ({ page }) => {
    await signupAndLogin(page)

    await page.goto('/admin/shipping-requests')
    await expect(page).not.toHaveURL(/\/admin/)
  })

  test('未ログインで管理 API を叩くと 401 になる', async ({ request }) => {
    const response = await request.get('/api/admin/shipping-requests')
    expect(response.status()).toBe(401)
  })

  test('管理者は申請を検品 → 梱包 → 発送済みまで進められる', async ({ page }) => {
    test.slow()

    // まず利用者が申請する
    const email = await signupAndLogin(page)
    await chargePoints(page, 3_000)
    const recipient = `架空 発送${Date.now().toString(36)}`
    await drawShippablePrizes(page)
    await registerAddress(page, recipient)

    await page.goto('/mypage/prizes')
    const panel = page.getByRole('group').filter({ hasText: '発送する商品' })
    await panel.getByRole('checkbox').first().check()
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: /点の発送を申請する$/ }).click()
    await expect(page).toHaveURL(/\/mypage\/shipments$/)

    // 管理者でログインし直して作業する
    await page.goto('/login')
    await page.getByLabel('メールアドレス').fill('admin@example.test')
    await page.getByLabel('パスワード').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: 'ログイン' }).click()
    await expect(page).toHaveURL(/\/mypage/)

    /*
     * 申請者で絞り込んでから開く。
     * 一覧は「待たせている順」＝古い順のページングなので、
     * 絞り込まずに探すと、いま作った申請は後ろのページにいて見つからない。
     */
    await page.goto(`/admin/shipping-requests?userEmail=${encodeURIComponent(email)}`)
    await expect(page.getByRole('link', { name: new RegExp(`${recipient} 宛`) })).toBeVisible()
    await page.getByRole('link', { name: new RegExp(`${recipient} 宛`) }).click()
    await expect(page).toHaveURL(/\/admin\/shipping-requests\/[^/]+$/)

    // 申請直後なので、次の 1 手は検品だけ
    await expect(page.getByRole('button', { name: '検品を開始する' })).toBeVisible()
    // 発送済みへ飛ばす導線は無い（段階を飛ばせない）
    await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(0)

    await page.getByRole('button', { name: '検品を開始する' }).click()
    await expect(page.getByText('検品を開始しました。')).toBeVisible()

    await page.getByRole('button', { name: '梱包を開始する' }).click()
    await expect(page.getByText('梱包を開始しました。')).toBeVisible()

    // 追跡番号が無いと発送済みにできない
    await expect(page.getByRole('button', { name: '発送済みにする' })).toBeDisabled()

    await page.getByLabel('配送業者').fill('ヤマト運輸')
    await page.getByLabel('追跡番号').fill('1234567890')
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: '発送済みにする' }).click()

    await expect(page.getByText('発送済みにしました。')).toBeVisible()
    await expect(page.getByText('1234567890')).toBeVisible()
  })

  test('管理画面に配送先の個人情報は出るが、一覧では宛名までに留める', async ({ page }) => {
    test.slow()

    await page.goto('/login')
    await page.getByLabel('メールアドレス').fill('admin@example.test')
    await page.getByLabel('パスワード').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: 'ログイン' }).click()
    await expect(page).toHaveURL(/\/mypage/)

    const response = await page.goto('/admin/shipping-requests')
    await expect(page.getByRole('heading', { name: '発送申請', level: 1 })).toBeVisible()

    // 一覧の HTML に電話番号を出さない（詳細でだけ見せる）
    const html = (await response?.text()) ?? ''
    expect(html).not.toContain('09012345678')
  })
})
