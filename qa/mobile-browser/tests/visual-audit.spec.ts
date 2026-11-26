import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'

const qrToken = createHash('sha256').update('platform-core-demo-qr-1').digest('base64url')
const screens = [
  { path: '/', name: 'super-admin-entry' },
  { path: '/owner?demo=1', name: 'owner-entry' },
  { path: `/r/platform-demo-restaurant/${qrToken}`, name: 'guest-table-1' },
]

async function auditLayout(page: Page, label: string) {
  const result = await page.evaluate(() => {
    const root = document.documentElement
    const body = document.body
    const visible = (element: Element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
    }
    const controls = [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [role="button"]')].filter(visible)
    const undersized = controls.map(element => {
      const rect = element.getBoundingClientRect()
      return { tag: element.tagName, text: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 48), width: Math.round(rect.width), height: Math.round(rect.height) }
    }).filter(item => item.width < 36 || item.height < 36)
    const clipped = [...document.querySelectorAll<HTMLElement>('body *')].filter(element => {
      if (!visible(element) || element.children.length > 0) return false
      const style = getComputedStyle(element)
      if (!['hidden', 'clip', ''].includes(style.overflowX) && !['hidden', 'clip', ''].includes(style.overflowY)) return false
      return element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2
    }).map(element => ({ tag: element.tagName, text: (element.textContent || '').trim().slice(0, 60) })).slice(0, 20)
    const interactive = controls.filter(element => {
      if (element.tagName !== 'BUTTON' && element.getAttribute('role') !== 'button') return false
      const rect = element.getBoundingClientRect()
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return Boolean(top && (top === element || element.contains(top)))
    })
    const overlaps: Array<{ first: string; second: string }> = []
    for (let i = 0; i < interactive.length; i++) {
      const a = interactive[i].getBoundingClientRect()
      for (let j = i + 1; j < interactive.length; j++) {
        const b = interactive[j].getBoundingClientRect()
        const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (width > 3 && height > 3) overlaps.push({ first: (interactive[i].innerText || interactive[i].getAttribute('aria-label') || '').trim().slice(0, 30), second: (interactive[j].innerText || interactive[j].getAttribute('aria-label') || '').trim().slice(0, 30) })
      }
    }
    const fixedBottomBars = [...document.querySelectorAll<HTMLElement>('body *')].filter(element => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return visible(element) && (style.position === 'fixed' || style.position === 'sticky') && rect.bottom >= innerHeight - 3 && rect.height > 24 && rect.height <= 120 && rect.width >= innerWidth * 0.5
    })
    const covered: string[] = []
    for (const control of controls) {
      const rect = control.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) continue
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2))
      const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2))
      const top = document.elementFromPoint(x, y)
      if (top && !control.contains(top) && !fixedBottomBars.some(bar => bar.contains(control))) {
        const topRect = top.getBoundingClientRect()
        if (topRect.width > 0 && topRect.height > 0 && top !== document.body && top !== document.documentElement) {
          if (fixedBottomBars.some(bar => bar === top || bar.contains(top))) covered.push((control.innerText || control.getAttribute('aria-label') || control.tagName).trim().slice(0, 40))
        }
      }
    }
    return {
      viewportWidth: root.clientWidth,
      documentWidth: root.scrollWidth,
      bodyWidth: body.scrollWidth,
      viewportHeight: innerHeight,
      pageHeight: root.scrollHeight,
      undersized,
      clipped,
      overlaps: overlaps.slice(0, 20),
      covered,
    }
  })
  expect(result.documentWidth, `${label}: document horizontal overflow ${JSON.stringify(result)}`).toBeLessThanOrEqual(result.viewportWidth + 2)
  expect(result.bodyWidth, `${label}: body horizontal overflow ${JSON.stringify(result)}`).toBeLessThanOrEqual(result.viewportWidth + 2)
  expect(result.pageHeight, `${label}: page did not render`).toBeGreaterThan(100)
  expect(result.undersized, `${label}: interactive targets below 36x36px`).toEqual([])
  expect(result.clipped, `${label}: clipped text detected`).toEqual([])
  expect(result.overlaps, `${label}: overlapping interactive controls`).toEqual([])
  expect(result.covered, `${label}: controls covered by a fixed bottom bar`).toEqual([])
}

for (const screen of screens) {
  test(`visual audit: ${screen.name}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const response = await page.goto(screen.path, { waitUntil: 'domcontentloaded' })
    expect(response, `${screen.name}: document response`).not.toBeNull()
    expect(response!.status(), `${screen.name}: server response`).toBeLessThan(500)
    await expect(page.locator('body')).not.toBeEmpty()
    if (screen.name === 'guest-table-1') await expect(page.getByText('Masala Dosa').first()).toBeVisible({ timeout: 20000 })
    else await page.waitForTimeout(1200)
    await auditLayout(page, screen.name)
    await page.screenshot({ path: `test-results/${test.info().project.name}-${screen.name}.png`, fullPage: true })
    expect(errors, `${screen.name}: uncaught browser errors`).toEqual([])
  })
}

test('guest customization and order review modals render and are screenshot-tested', async ({ page }) => {
  await page.goto(screens[2].path, { waitUntil: 'domcontentloaded' })
  const dosa = page.locator('.guest-item').filter({ hasText: 'Masala Dosa' }).first()
  await expect(dosa).toBeVisible({ timeout: 20000 })
  await dosa.getByRole('button', { name: 'ADD +' }).click()
  await expect(page.locator('.guest-modal').getByRole('heading', { name: 'Masala Dosa' })).toBeVisible()
  await auditLayout(page, 'guest-item-customization-modal')
  await page.screenshot({ path: `test-results/${test.info().project.name}-guest-customization-modal.png`, fullPage: true })
  await page.getByRole('button', { name: 'Add to order' }).click()
  const review = page.getByRole('button', { name: /Review order/ })
  await expect(review).toBeVisible()
  await review.click()
  await expect(page.getByRole('heading', { name: 'Order summary' })).toBeVisible()
  await auditLayout(page, 'guest-order-review-modal')
  await page.screenshot({ path: `test-results/${test.info().project.name}-guest-order-review-modal.png`, fullPage: true })
})

test('guest language selector exposes all configured Indian languages', async ({ page }) => {
  await page.goto(screens[2].path, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.guest-categories')).toBeVisible({ timeout: 20000 })
  const options = (await page.locator('select[aria-label="Menu language"] option').allTextContents()).join(' ').toLowerCase()
  for (const language of ['English', 'हिन्दी', 'ಕನ್ನಡ', 'தமிழ்', 'తెలుగు', 'മലയാളം']) {
    expect(options).toContain(language.toLowerCase())
  }
})

test('API health and readiness are successful', async ({ request }) => {
  const health = await request.get('/api/health')
  expect(health.status()).toBe(200)
  const ready = await request.get('/api/ready')
  expect(ready.status()).toBe(200)
})
