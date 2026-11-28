import { test, expect } from '@playwright/test'
import { api, signIn, QA_CREDENTIALS, DEMO_SLUG } from '../demo-helpers'

test.afterEach(async ({ page }) => {
  if (!page.url().startsWith('http')) return
  const session = await api(page, 'GET', '/api/auth/session')
  if (session.body?.authenticated) {
    const logout = await api(page, 'POST', '/api/auth/logout')
    expect(logout.status).toBe(200)
    expect((await api(page, 'GET', '/api/auth/session')).body.authenticated).toBe(false)
  }
})

test('live production Demo Bistro cook, waiter and manager sign in to their assigned dashboards', async ({ page, request }) => {
  const healthResponse = await request.get('/api/health')
  expect(healthResponse.ok()).toBeTruthy()
  const health = await healthResponse.json()
  test.skip(health.environment !== 'production', 'This non-mutating role smoke test runs only against the live production Worker.')
  const ready = await request.get('/api/ready')
  expect(ready.ok()).toBeTruthy()

  await page.goto('/')
  const adminDenied = await api(page, 'POST', '/api/auth/login', QA_CREDENTIALS.admin)
  expect(adminDenied.status, 'demo.admin must remain preview-only in production').toBe(401)
  expect((await api(page, 'GET', '/api/auth/session')).body.authenticated).toBe(false)

  const staffRoles = [
    { role: 'cook', credentials: QA_CREDENTIALS.cook, heading: 'Kitchen queue' },
    { role: 'waiter', credentials: QA_CREDENTIALS.waiter, heading: 'Service board' },
    { role: 'manager', credentials: QA_CREDENTIALS.manager, heading: 'Restaurant operations' },
  ] as const

  for (const item of staffRoles) {
    const user = await signIn(page, item.credentials)
    expect(user.memberships.some((membership: any) =>
      membership.tenant_slug === DEMO_SLUG && membership.staff_role === item.role)).toBe(true)
    await page.goto('/staff')
    await expect(page.locator('.staff-portal')).toBeVisible({ timeout: 20000 })
    await expect(page.getByRole('heading', { name: item.heading })).toBeVisible()
    if (item.role === 'manager') {
      for (const label of ['Menu', 'Tables', 'Operations', 'Settings', 'Reports']) {
        await expect(page.locator('.staff-portal-tabs').getByRole('button', { name: label, exact: true })).toBeVisible()
      }
    }
    const logout = await api(page, 'POST', '/api/auth/logout')
    expect(logout.status).toBe(200)
    expect((await api(page, 'GET', '/api/auth/session')).body.authenticated).toBe(false)
  }
})
