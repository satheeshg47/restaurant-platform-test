import { test, expect } from '@playwright/test'

const routes = [
  { path: '/', label: 'Super Admin sign-in' },
  { path: '/owner?demo=1', label: 'Demo owner entry' },
]

for (const route of routes) {
  test(`${route.label} opens and fits a mobile viewport`, async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))

    const response = await page.goto(route.path, { waitUntil: 'domcontentloaded' })
    expect(response, 'The browser should receive a document response').not.toBeNull()
    expect(response!.status(), 'The route should not return a server error').toBeLessThan(500)

    await expect(page.locator('body')).not.toBeEmpty()
    await page.waitForTimeout(1200)

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
