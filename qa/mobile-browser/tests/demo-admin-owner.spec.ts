import { test, expect } from '@playwright/test'
import { api, signIn, createContextPage, QA_CREDENTIALS, DEMO_SLUG, qrToken } from '../demo-helpers'

test('Demo Bistro one-click Admin entry and authenticated Owner management', async ({ page, browser, request }, testInfo) => {
  const healthResponse = await request.get('/api/health')
  expect(healthResponse.ok()).toBeTruthy()
  const health = await healthResponse.json()
  test.skip(health.environment !== 'preview', 'Demo workspace mutations run only against isolated preview D1.')

  const admin = await signIn(page, QA_CREDENTIALS.admin)
  expect(admin.is_admin).toBe(true)
  const reset = await api(page, 'POST', '/api/admin/demo-restaurant/reset')
  expect(reset.status).toBe(200)
  expect(reset.body.tenant.name).toBe('Demo Bistro')
  expect(reset.body.retention.days).toBe(365)

  await page.goto('/')
  await expect(page.locator('.shell')).toBeVisible()
  const nav = (label: string) => page.locator('.sidebar nav .nav-item').filter({ hasText: label }).first()
  await nav('Apps').click()
  await expect(page.getByRole('link', { name: /Open Demo Bistro/ })).toHaveAttribute('href', '/owner?demo=1')
  await expect(page.getByRole('button', { name: 'Reset Demo Bistro' })).toBeVisible()
  for (const label of ['Subscribers', 'Messages', 'Subscriptions']) {
    await nav(label).click()
    await expect(page.locator('.shell')).toBeVisible()
  }

  const viewport = testInfo.project.use.viewport as { width: number; height: number }
  const ownerContext = await createContextPage(browser, viewport)
  const ownerPage = ownerContext.page
  const owner = await signIn(ownerPage, QA_CREDENTIALS.owner)
  expect(owner.is_admin).toBe(false)
  expect(owner.tenant_role).toBe('owner')
  await ownerPage.goto('/owner')
  await expect(ownerPage.locator('.owner-portal-content')).toBeVisible({ timeout: 15000 })
  if (await ownerPage.locator('.owner-home-open').count()) await ownerPage.locator('.owner-home-open').first().click()
  await expect(ownerPage.locator('.owner-workspace-sidebar')).toBeVisible()

  const restaurants = await api(ownerPage, 'GET', '/api/owner/restaurants')
  expect(restaurants.status).toBe(200)
  const demo = restaurants.body.restaurants.find((restaurant: any) => restaurant.tenant_slug === DEMO_SLUG)
  expect(demo).toBeTruthy()
  expect(demo.tenant_name).toBe('Demo Bistro')

  const menu = await api(ownerPage, 'GET', '/api/restaurant/' + DEMO_SLUG + '/menu')
  expect(menu.status).toBe(200)
  const item = menu.body.items.find((entry: any) => entry.name.en === 'Masala Dosa')
  expect(item.name.hi).toBeTruthy()
  expect(item.name.kn).toBeTruthy()
  const variant = menu.body.variants.find((entry: any) => entry.item_id === item.id && entry.name.en === 'Large')
  expect(variant).toBeTruthy()
  const itemGroup = menu.body.item_addon_groups.find((entry: any) => entry.item_id === item.id)
  const addon = menu.body.addons.find((entry: any) => entry.group_id === itemGroup.group_id && entry.name.en === 'Extra Ghee')
  expect(addon).toBeTruthy()
  expect((await api(ownerPage, 'PATCH', '/api/restaurant/' + DEMO_SLUG + '/menu/items/' + item.id, {
    name: { en: 'Masala Dosa', hi: 'मसाला डोसा QA', kn: 'ಮಸಾಲೆ ದೋಸೆ QA' },
  })).status).toBe(200)
  expect((await api(ownerPage, 'PATCH', '/api/restaurant/' + DEMO_SLUG + '/menu/variants/' + variant.id, {
    name: { en: 'Large', hi: 'बड़ा', kn: 'ದೊಡ್ಡ' }, price_minor: 11000,
  })).status).toBe(200)
  expect((await api(ownerPage, 'PATCH', '/api/restaurant/' + DEMO_SLUG + '/menu/addons/' + addon.id, {
    name: { en: 'Extra Ghee', hi: 'अतिरिक्त घी', kn: 'ಹೆಚ್ಚುವರಿ ತುಪ್ಪ' }, price_minor: 1500,
  })).status).toBe(200)

  const tables = await api(ownerPage, 'GET', '/api/restaurant/' + DEMO_SLUG + '/tables')
  const tableOne = tables.body.tables.find((entry: any) => entry.table_number === 1)
  expect(tableOne.qr_url).toContain(qrToken(1))
  const changedTable = await api(ownerPage, 'PATCH', '/api/restaurant/' + DEMO_SLUG + '/tables/' + tableOne.id, { label: 'Table 1 QA' })
  expect(changedTable.status).toBe(200)
  const createdTable = await api(ownerPage, 'POST', '/api/restaurant/' + DEMO_SLUG + '/tables', {
    label: 'QA Table 11', table_type: 'dine_in', table_number: 11,
  })
  expect(createdTable.status).toBe(201)
  const afterCreate = await api(ownerPage, 'GET', '/api/restaurant/' + DEMO_SLUG + '/tables')
  expect(afterCreate.body.tables.find((entry: any) => entry.id === createdTable.body.table.id).qr_url).toContain(createdTable.body.qr_token)

  const staff = await api(ownerPage, 'GET', '/api/owner/staff?tenant_id=' + encodeURIComponent(demo.tenant_id))
  expect(staff.status).toBe(200)
  const loginId = 'qa.revocation.waiter'
  const password = 'QARevocation#2026!'
  let temp = staff.body.staff.find((entry: any) => entry.login_id === loginId)
  if (!temp) {
    const created = await api(ownerPage, 'POST', '/api/owner/staff', {
      tenant_id: demo.tenant_id, login_id: loginId, display_name: 'QA Revocation Waiter', password, role: 'waiter',
    })
    expect(created.status).toBe(201)
    temp = created.body.staff
  } else {
    expect((await api(ownerPage, 'PATCH', '/api/owner/staff/' + temp.staff_id, {
      tenant_id: demo.tenant_id, active: true, role: 'waiter',
    })).status).toBe(200)
    expect((await api(ownerPage, 'POST', '/api/owner/staff/' + temp.staff_id + '/password', {
      tenant_id: demo.tenant_id, password,
    })).status).toBe(200)
  }
  const revoked = await api(ownerPage, 'PATCH', '/api/owner/staff/' + temp.staff_id, {
    tenant_id: demo.tenant_id, active: false,
  })
  expect(revoked.status).toBe(200)
  const deniedContext = await createContextPage(browser, viewport)
  await deniedContext.page.goto('/')
  expect((await api(deniedContext.page, 'POST', '/api/auth/login', { login_id: loginId, password })).status).toBe(401)
  await deniedContext.context.close()

  expect((await api(ownerPage, 'GET', '/api/restaurant/' + DEMO_SLUG + '/settings')).status).toBe(200)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  expect((await api(ownerPage, 'GET', '/api/restaurant/' + DEMO_SLUG + '/reports?from=' + today + '&to=' + today)).status).toBe(200)
  expect((await api(ownerPage, 'GET', '/api/restaurant/' + DEMO_SLUG + '/reviews')).status).toBe(200)
  await ownerContext.context.close()
})
