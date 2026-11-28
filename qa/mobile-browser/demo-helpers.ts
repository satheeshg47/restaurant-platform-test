import { expect, type Page, type Browser } from '@playwright/test'
import { createHash } from 'node:crypto'

export const BASE_URL = (process.env.BASE_URL || 'https://restaurant-platform-test.iamsatheeshgkotegar.workers.dev').replace(/\/$/, '')
export const DEMO_SLUG = 'platform-demo-restaurant'
export const QA_CREDENTIALS = {
  admin: { login_id: 'demo.admin', password: process.env.DEMO_ADMIN_PASSWORD || 'DemoAdmin#2026!' },
  owner: { login_id: 'demo.owner', password: process.env.DEMO_OWNER_PASSWORD || 'DemoOwner#2026!' },
  cook: { login_id: 'demo.cook', password: process.env.DEMO_COOK_PASSWORD || 'DemoCook#2026!' },
  waiter: { login_id: 'demo.waiter', password: process.env.DEMO_WAITER_PASSWORD || 'DemoWaiter#2026!' },
}

export async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, { method, path, body })
}

export async function signIn(page: Page, credentials: { login_id: string; password: string }) {
  await page.goto('/')
  const result = await api(page, 'POST', '/api/auth/login', credentials)
  expect(result.status, 'Sign-in failed for ' + credentials.login_id + ': ' + JSON.stringify(result.body)).toBe(200)
  const session = await api(page, 'GET', '/api/auth/session')
  expect(session.status).toBe(200)
  expect(session.body.authenticated).toBe(true)
  return session.body.user
}

export function qrToken(tableNumber: number) {
  return createHash('sha256').update('platform-core-demo-qr-' + tableNumber).digest('base64url')
}

export async function createContextPage(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({
    baseURL: BASE_URL, viewport, deviceScaleFactor: 1,
    isMobile: viewport.width < 500, hasTouch: viewport.width < 500,
  })
  return { context, page: await context.newPage() }
}

export async function placeGuestOrder(page: Page, token: string, guestPin: string) {
  await page.goto('/r/' + DEMO_SLUG + '/' + token)
  await page.getByLabel('6-digit table PIN').fill(guestPin)
  await page.getByRole('button', { name: 'Verify PIN' }).click()
  await expect(page.getByText('Table verified')).toBeVisible()
  const item = page.locator('.guest-item').filter({ hasText: 'Masala Dosa' }).first()
  await expect(item).toBeVisible({ timeout: 20000 })
  const responsePromise = page.waitForResponse(response =>
    response.url().includes('/api/restaurant/' + DEMO_SLUG + '/guest/' + token + '/orders') &&
    response.request().method() === 'POST',
  )
  await item.getByRole('button', { name: 'ADD +' }).click()
  await page.getByRole('radio', { name: /Large/ }).check()
  await page.getByRole('checkbox', { name: /Extra Ghee/ }).check()
  await page.getByRole('button', { name: 'Add to order' }).click()
  await page.getByRole('button', { name: /Review order/ }).click()
  await page.getByRole('button', { name: /Place order/ }).click()
  const response = await responsePromise
  const payload = await response.json()
  expect(response.status(), JSON.stringify(payload)).toBe(201)
  await expect(page.locator('.guest-success')).toBeVisible()
  return payload.order as { id: string; order_number: number; total_minor: number }
}
