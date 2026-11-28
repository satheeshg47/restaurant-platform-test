import { randomBytes } from 'node:crypto'
import { test, expect, type BrowserContext } from '@playwright/test'
import { api, signIn, QA_CREDENTIALS, DEMO_SLUG } from '../demo-helpers'

test('production Owner Staff panel opens role links, creates a QA waiter, and revokes access', async ({ page, browser, request }) => {
  const healthResponse = await request.get('/api/health')
  expect(healthResponse.ok()).toBeTruthy()
  const health = await healthResponse.json()
  test.skip(health.environment !== 'production', 'This staff-panel smoke test runs only against the live production Worker.')

  const owner = await signIn(page, QA_CREDENTIALS.owner)
  expect(owner.tenant_role).toBe('owner')
  await page.goto('/owner')
  await expect(page.locator('.owner-portal-content')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.owner-home-open').first()).toBeVisible({ timeout: 20000 })
  await page.locator('.owner-home-open').first().click()
  await expect(page.locator('.owner-workspace-sidebar')).toBeVisible({ timeout: 20000 })

  const restaurants = await api(page, 'GET', '/api/owner/restaurants')
  expect(restaurants.status).toBe(200)
  const demo = restaurants.body.restaurants.find((entry: any) => entry.tenant_slug === DEMO_SLUG)
  expect(demo).toBeTruthy()

  const staffNav = page.locator('.owner-workspace-sidebar nav button').filter({ hasText: 'Staff access' }).first()
  await staffNav.click()
  const panel = page.locator('.owner-staff')
  await expect(panel).toBeVisible()
  const demoLinks = panel.locator('.owner-staff-demo-link')
  await expect(demoLinks).toHaveCount(3)
  for (const role of ['Cook', 'Waiter', 'Manager']) {
    const linkRow = demoLinks.filter({ hasText: role }).first()
    await expect(linkRow.getByRole('link')).toHaveAttribute('href', '/staff?login=1')
  }
  const waiterLink = demoLinks.filter({ hasText: 'Waiter' }).first().getByRole('link', { name: /Open waiter sign-in link/ })
  const [staffLoginPage] = await Promise.all([page.waitForEvent('popup'), waiterLink.click()])
  await expect(staffLoginPage).toHaveURL(/\/staff\?login=1$/)
  await expect(staffLoginPage.locator('.signin-form input[type="password"]')).toBeVisible()
  await staffLoginPage.close()

  const loginId = 'qa.platformcore.live.staff.revocation'
  const password = 'QALiveRevocation#' + randomBytes(18).toString('base64url')
  const staffListPath = '/api/owner/staff?tenant_id=' + encodeURIComponent(demo.tenant_id)
  let staffId = ''
  let staffContext: BrowserContext | null = null

  try {
    const initialList = await api(page, 'GET', staffListPath)
    expect(initialList.status).toBe(200)
    let record = initialList.body.staff.find((entry: any) => entry.login_id === loginId)

    if (!record) {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await panel.locator('.owner-staff-toolbar').getByRole('button', { name: /Add staff/ }).click()
      const form = panel.locator('.owner-staff-form')
      await expect(form).toBeVisible()
      await form.getByLabel('Staff name').fill('QA Live Smoke Waiter')
      await form.getByLabel('Login ID').fill(loginId)
      await form.getByLabel('Temporary password').fill(password)
      await form.getByLabel('Role').selectOption('waiter')
      await form.getByRole('button', { name: 'Create account' }).click()

      const createdCredentials = panel.locator('.owner-staff-created').filter({ hasText: 'New staff credentials' })
      await expect(createdCredentials).toBeVisible()
      await createdCredentials.getByRole('button', { name: 'Copy credentials' }).click()
      const copied = await page.evaluate(() => navigator.clipboard.readText())
      expect(copied).toContain(loginId)
      expect(copied).toContain(password)

      const refreshed = await api(page, 'GET', staffListPath)
      expect(refreshed.status).toBe(200)
      record = refreshed.body.staff.find((entry: any) => entry.login_id === loginId)
    } else {
      if (record.active) {
        const suspended = await api(page, 'PATCH', '/api/owner/staff/' + record.staff_id, {
          tenant_id: demo.tenant_id, active: false,
        })
        expect(suspended.status).toBe(200)
      }
      const reset = await api(page, 'POST', '/api/owner/staff/' + record.staff_id + '/password', {
        tenant_id: demo.tenant_id, password,
      })
      expect(reset.status).toBe(200)
      const reactivated = await api(page, 'PATCH', '/api/owner/staff/' + record.staff_id, {
        tenant_id: demo.tenant_id, active: true, role: 'waiter',
      })
      expect(reactivated.status).toBe(200)
      await panel.locator('.owner-staff-toolbar').getByRole('button', { name: 'Refresh' }).click()
    }

    expect(record, 'The QA staff account must appear in the Owner Staff list').toBeTruthy()
    staffId = record.staff_id
    expect(record.role).toBe('waiter')

    staffContext = await browser.newContext({ baseURL: process.env.BASE_URL, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    const staffPage = await staffContext.newPage()
    const staffUser = await signIn(staffPage, { login_id: loginId, password })
    expect(staffUser.memberships.some((membership: any) => membership.tenant_slug === DEMO_SLUG && membership.staff_role === 'waiter')).toBe(true)
    await staffPage.goto('/staff')
    await expect(staffPage.locator('.staff-portal')).toBeVisible()
    await expect(staffPage.getByRole('heading', { name: 'Service board' })).toBeVisible()

    const staffRow = panel.locator('.owner-staff-row').filter({ hasText: loginId })
    await expect(staffRow).toBeVisible()
    await staffRow.getByRole('button', { name: 'Suspend' }).click()
    await expect(panel.locator('.owner-staff-notice')).toContainText('Staff account suspended and active sessions revoked.')

    const revokedSession = await api(staffPage, 'GET', '/api/auth/session')
    expect(revokedSession.status).toBe(200)
    expect(revokedSession.body.authenticated).toBe(false)
    const deniedLogin = await api(staffPage, 'POST', '/api/auth/login', { login_id: loginId, password })
    expect(deniedLogin.status).toBe(401)
  } finally {
    try {
      if (!staffId) {
        const latest = await api(page, 'GET', staffListPath)
        staffId = latest.body?.staff?.find((entry: any) => entry.login_id === loginId)?.staff_id || ''
      }
      if (staffId) {
        const latest = await api(page, 'GET', staffListPath)
        const record = latest.body?.staff?.find((entry: any) => entry.staff_id === staffId)
        if (record?.active) {
          await api(page, 'PATCH', '/api/owner/staff/' + staffId, { tenant_id: demo.tenant_id, active: false })
        }
      }
      await api(page, 'POST', '/api/auth/logout')
    } catch (error) {
      console.error('QA staff cleanup will be retried on the next production smoke run:', error)
    }
    if (staffContext) await staffContext.close()
  }
})
