import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'

const tableOneToken = createHash('sha256').update('platform-core-demo-qr-1').digest('base64url')
const routes = [
  { path: '/', label: 'Super Admin sign-in' },
  { path: '/owner?demo=1', label: 'Demo owner entry' },
  { path: `/r/platform-demo-restaurant/${tableOneToken}`, label: 'Table 1 QR menu', expectedText: 'Masala Dosa' },
]

for (const route of routes) {
  test(`${route.label} opens and fits a mobile viewport`, async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))

    const response = await page.goto(route.path, { waitUntil: 'domcontentloaded' })
    expect(response, 'The browser should receive a document response').not.toBeNull()
    expect(response!.status(), 'The route should not return a server error').toBeLessThan(500)

    await expect(page.locator('body')).not.toBeEmpty()
    if ('expectedText' in route) await expect(page.getByText(route.expectedText).first()).toBeVisible({ timeout: 15000 })
    else await page.waitForTimeout(1200)

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      height: document.documentElement.scrollHeight,
    }))
    expect(dimensions.document, `Horizontal overflow detected: ${JSON.stringify(dimensions)}`)
      .toBeLessThanOrEqual(dimensions.viewport + 2)
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 2)
    expect(dimensions.height).toBeGreaterThan(100)
    expect(pageErrors, 'No uncaught browser JavaScript errors').toEqual([])

    await page.screenshot({ path: `test-results/${test.info().project.name}-${route.label.toLowerCase().replaceAll(' ', '-')}.png`, fullPage: true })
  })
}

test('health and readiness endpoints respond', async ({ request }) => {
  const health = await request.get('/api/health')
  expect(health.status()).toBeLessThan(500)
  const ready = await request.get('/api/ready')
  expect(ready.status()).toBeLessThan(500)
})


test('guest menu supports category swipe, item quantity controls and a clear order review action', async ({ page }) => {
  const response = await page.goto(routes[2].path, { waitUntil: 'domcontentloaded' })
  expect(response?.status()).toBeLessThan(500)
  const categories = page.locator('.guest-categories')
  await expect(categories).toBeVisible()
  await expect(page.getByRole('button', { name: 'Call waiter' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Request bill' })).toBeVisible()
  const categoryRail = await categories.evaluate(element => ({ overflowX: getComputedStyle(element).overflowX, touchAction: getComputedStyle(element).touchAction }))
  expect(categoryRail.overflowX).toBe('auto')
  expect(categoryRail.touchAction).toContain('pan-x')

  const dosa = page.locator('.guest-item').filter({ hasText: 'Masala Dosa' }).first()
  await expect(dosa).toBeVisible()
  await dosa.getByRole('button', { name: 'ADD +' }).click()
  const customise = page.locator('.guest-modal').getByRole('heading', { name: 'Masala Dosa' })
  await expect(customise).toBeVisible()
  await page.getByRole('button', { name: 'Add to order' }).click()
  const review = page.getByRole('button', { name: /Review order/ })
  await expect(review).toBeVisible()
  await review.click()
  await expect(page.getByRole('heading', { name: 'Order summary' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Place order/ })).toBeVisible()
  // Do not submit a live demo order from the scheduled smoke suite.
})


test('guest category pills stay synchronized with scroll and sticky controls remain reachable', async ({ page }) => {
  await page.goto(routes[2].path, { waitUntil: 'domcontentloaded' })
  const rail = page.locator('.guest-categories')
  await expect(rail).toBeVisible({ timeout: 20000 })
  const pills = rail.locator('button')
  const count = await pills.count()
  expect(count).toBeGreaterThan(1)
  const second = pills.nth(1)
  await second.click()
  await expect(second).toHaveClass(/active/)
  await page.waitForTimeout(1300)
  const lastSection = page.locator('[data-category-section]').last()
  await lastSection.evaluate(element => {
    const title = element.querySelector('.guest-section-title')!
    const headerHeight = document.querySelector('.guest-header')!.getBoundingClientRect().height
    const categoryHeight = document.querySelector('.guest-categories')!.getBoundingClientRect().height
    const activeLine = Math.max(headerHeight + categoryHeight + 12, window.innerHeight * 0.8)
    window.scrollTo(0, window.scrollY + title.getBoundingClientRect().top - activeLine - 4)
  })
  await page.waitForTimeout(450)
  const lastId = await lastSection.getAttribute('data-category-section')
  await expect(rail.locator('button.active')).toHaveAttribute('aria-current', 'location')
  await expect(rail.locator('button.active')).toHaveText((await lastSection.locator('.guest-section-title h2').innerText()).trim())
  const header = page.locator('.guest-header')
  const geometry = await page.evaluate(() => {
    const header = document.querySelector('.guest-header')!.getBoundingClientRect()
    const categories = document.querySelector('.guest-categories')!.getBoundingClientRect()
    return { headerTop: header.top, headerBottom: header.bottom, categoriesTop: categories.top }
  })
  expect(geometry.headerTop).toBeGreaterThanOrEqual(-1)
  expect(geometry.headerTop).toBeLessThanOrEqual(1)
  expect(geometry.categoriesTop).toBeGreaterThanOrEqual(geometry.headerBottom - 2)
  expect(await header.isVisible()).toBeTruthy()
  expect(lastId).toBeTruthy()
})
