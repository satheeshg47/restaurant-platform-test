import { test, expect } from '@playwright/test'
import { api, signIn, createContextPage, placeGuestOrder, QA_CREDENTIALS, DEMO_SLUG, qrToken } from '../demo-helpers'

test('Guest QR order flows through kitchen, waiter, payment, reports and reviews', async ({ page, browser, request }, testInfo) => {
  const healthResponse = await request.get('/api/health')
  expect(healthResponse.ok()).toBeTruthy()
  const health = await healthResponse.json()
  const readyResponse = await request.get('/api/ready')
  expect(readyResponse.ok(), 'Preview schema must be fully migrated before browser QA').toBeTruthy()
  test.skip(health.environment !== 'preview', 'Mutating Demo Bistro QA is restricted to the isolated preview D1 database.')

  const viewport = testInfo.project.use.viewport as { width: number; height: number }
  const admin = await signIn(page, QA_CREDENTIALS.admin)
  expect(admin.is_admin).toBe(true)
  // Demo Bistro is reset once by demo-admin-owner.spec.ts for each viewport.
  // Re-resetting here doubles destructive D1 writes without improving isolation.
  const ownerContext = await createContextPage(browser, viewport)
  const ownerPage = ownerContext.page
  const owner = await signIn(ownerPage, QA_CREDENTIALS.owner)
  expect(owner.tenant_role).toBe('owner')
  const ownerRestaurants = await api(ownerPage, 'GET', '/api/owner/restaurants')
  const demo = ownerRestaurants.body.restaurants.find((entry: any) => entry.tenant_slug === DEMO_SLUG)
  expect(demo).toBeTruthy()

  const waiterContext = await createContextPage(browser, viewport)
  const waiterPage = waiterContext.page
  const waiter = await signIn(waiterPage, QA_CREDENTIALS.waiter)
  expect(waiter.memberships.some((entry: any) => entry.staff_role === 'waiter')).toBe(true)
  await waiterPage.goto('/staff')
  await expect(waiterPage.locator('.staff-portal')).toBeVisible()
  await expect(waiterPage.getByRole('heading', { name: 'Service board' })).toBeVisible()

  const tables = await api(waiterPage, 'GET', '/api/restaurant/' + DEMO_SLUG + '/tables')
  expect(tables.status).toBe(200)
  const tableOne = tables.body.tables.find((entry: any) => entry.table_number === 1)
  const tableTwo = tables.body.tables.find((entry: any) => entry.table_number === 2)
  expect(tableOne.qr_url).toContain(qrToken(1))
  expect(tableTwo.qr_url).toContain(qrToken(2))
  const sessionOneResult = await api(waiterPage, 'POST', '/api/restaurant/' + DEMO_SLUG + '/tables/' + tableOne.id + '/sessions', { guest_count: 2 })
  const sessionTwoResult = await api(waiterPage, 'POST', '/api/restaurant/' + DEMO_SLUG + '/tables/' + tableTwo.id + '/sessions', { guest_count: 3 })
  expect(sessionOneResult.status).toBe(201)
  expect(sessionTwoResult.status).toBe(201)
  const sessionOne = sessionOneResult.body.session
  const sessionTwo = sessionTwoResult.body.session

  const guestOneContext = await createContextPage(browser, viewport)
  const guestTwoContext = await createContextPage(browser, viewport)
  const guestOne = guestOneContext.page
  const guestTwo = guestTwoContext.page
  const tokenOne = qrToken(1)
  const tokenTwo = qrToken(2)
  const [orderOne, orderTwo] = await Promise.all([
    placeGuestOrder(guestOne, tokenOne, sessionOne.guest_pin),
    placeGuestOrder(guestTwo, tokenTwo, sessionTwo.guest_pin),
  ])
  expect(orderOne.id).not.toBe(orderTwo.id)
  expect(orderOne.order_number).not.toBe(orderTwo.order_number)

  expect((await api(guestOne, 'POST', '/api/restaurant/' + DEMO_SLUG + '/guest/' + tokenOne + '/requests', {
    session_id: sessionOne.id, guest_pin: sessionOne.guest_pin, request_type: 'need_water',
  })).status).toBe(201)
  expect((await api(guestTwo, 'POST', '/api/restaurant/' + DEMO_SLUG + '/guest/' + tokenTwo + '/requests', {
    session_id: sessionTwo.id, guest_pin: sessionTwo.guest_pin, request_type: 'call_waiter',
  })).status).toBe(201)
  expect((await api(guestOne, 'POST', '/api/restaurant/' + DEMO_SLUG + '/guest/' + tokenOne + '/requests', {
    session_id: sessionOne.id, guest_pin: sessionOne.guest_pin, request_type: 'request_bill',
  })).status).toBe(201)

  const cookContext = await createContextPage(browser, viewport)
  const cookPage = cookContext.page
  const cook = await signIn(cookPage, QA_CREDENTIALS.cook)
  expect(cook.memberships.some((entry: any) => entry.staff_role === 'cook')).toBe(true)
  await cookPage.goto('/staff')
  await expect(cookPage.locator('.staff-portal')).toBeVisible()
  await expect(cookPage.getByRole('heading', { name: 'Kitchen queue' })).toBeVisible()
  const groupedBatch = cookPage.locator('.restaurant-kitchen-batch-card').filter({ hasText: 'Large' }).filter({ hasText: 'Extra Ghee' })
  await expect(groupedBatch).toHaveCount(1, { timeout: 20000 })
  await expect(groupedBatch).toContainText('Combined quantity 2')
  await expect(groupedBatch).toContainText('Table 1')
  await expect(groupedBatch).toContainText('Table 2')
  await expect(groupedBatch.getByRole('button', { name: 'Print KOT' })).toBeVisible()
  await cookPage.getByRole('combobox', { name: 'Thermal printer width' }).selectOption('58')
  await cookPage.evaluate(() => { (window as any).__printCalls = 0; window.print = () => { (window as any).__printCalls++ } })
  await groupedBatch.getByRole('button', { name: 'Print KOT' }).click()
  await expect(cookPage.locator('.restaurant-kot-print.print-width-58')).toContainText('KITCHEN ORDER TICKET')
  await expect(cookPage.locator('.restaurant-kot-print')).toContainText('Extra Ghee')
  await expect.poll(() => cookPage.evaluate(() => (window as any).__printCalls)).toBe(1)
  await expect(cookPage.getByRole('button', { name: 'Enable chime' })).toBeVisible()
  await cookPage.getByRole('button', { name: 'Enable chime' }).click()
  await expect(cookPage.getByRole('button', { name: 'Sound enabled' })).toBeVisible()
  await cookPage.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(cookPage.locator('.restaurant-connection-state')).toContainText('Offline')
  await cookPage.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(cookPage.locator('.restaurant-connection-state')).toContainText('Online')
  await expect(cookPage.getByRole('combobox', { name: 'Thermal printer width' })).toHaveValue('58')
  await cookPage.emulateMedia({ media: 'print' })
  await expect(cookPage.locator('.restaurant-kot-print.print-width-58')).toBeVisible()
  await cookPage.emulateMedia({ media: 'screen' })
  await waiterPage.getByRole('button', { name: 'Refresh' }).click()
  await waiterPage.getByRole('button', { name: 'View / print bill' }).first().click()
  const billModal = waiterPage.locator('.restaurant-bill-modal')
  await expect(billModal).toContainText('Masala Dosa')
  await expect(billModal).toContainText('Large')
  await expect(billModal).toContainText('Extra Ghee')
  await expect(billModal).toContainText('GSTIN: 29ABCDE1234F1Z5')
  await expect(billModal).toContainText('FSSAI License No: 11223344556677')
  await billModal.getByRole('combobox', { name: 'Thermal printer width' }).selectOption('80')
  await expect(billModal.getByRole('button', { name: 'Print bill' })).toBeVisible()
  await waiterPage.evaluate(() => { (window as any).__printCalls = 0; window.print = () => { (window as any).__printCalls++ } })
  await billModal.getByRole('button', { name: 'Print bill' }).click()
  expect(await waiterPage.evaluate(() => (window as any).__printCalls)).toBe(1)
  await waiterPage.emulateMedia({ media: 'print' })
  await expect(billModal).toBeVisible()
  await waiterPage.emulateMedia({ media: 'screen' })
  await billModal.getByRole('button', { name: 'Done' }).click()

  const kitchen = await api(cookPage, 'GET', '/api/restaurant/' + DEMO_SLUG + '/kitchen/queue')
  expect(kitchen.status).toBe(200)
  const targetRows = kitchen.body.queue.filter((row: any) => [orderOne.id, orderTwo.id].includes(row.order_id))
  expect(targetRows).toHaveLength(2)
  expect(new Set(targetRows.map((row: any) => row.batch_id)).size).toBe(1)
  expect(Number(targetRows[0].total_quantity)).toBe(2)
  expect(new Set(targetRows.map((row: any) => row.table_label)).size).toBe(2)

  for (const row of targetRows) {
    for (const status of ['accepted', 'preparing', 'ready']) {
      const result = await api(cookPage, 'PATCH', '/api/restaurant/' + DEMO_SLUG + '/kitchen/items/' + row.order_item_id + '/status', { status })
      expect(result.status, JSON.stringify(result.body)).toBe(200)
    }
  }

  const board = await api(waiterPage, 'GET', '/api/restaurant/' + DEMO_SLUG + '/waiter/board')
  expect(board.status).toBe(200)
  const readyItems = board.body.ready_items.filter((entry: any) => [orderOne.id, orderTwo.id].includes(entry.order_id))
  expect(readyItems).toHaveLength(2)
  const activeRequests = board.body.service_requests.filter((entry: any) => [sessionOne.id, sessionTwo.id].includes(entry.session_id))
  expect(activeRequests.length).toBeGreaterThanOrEqual(3)
  for (const serviceRequest of activeRequests) {
    expect((await api(waiterPage, 'PATCH', '/api/restaurant/' + DEMO_SLUG + '/waiter/requests/' + serviceRequest.id, { status: 'handled' })).status).toBe(200)
  }
  for (const item of readyItems) {
    expect((await api(waiterPage, 'POST', '/api/restaurant/' + DEMO_SLUG + '/waiter/items/' + item.order_item_id + '/serve')).status).toBe(200)
  }

  for (const entry of [
    { tableId: tableOne.id, sessionId: sessionOne.id },
    { tableId: tableTwo.id, sessionId: sessionTwo.id },
  ]) {
    const bill = await api(waiterPage, 'GET', '/api/restaurant/' + DEMO_SLUG + '/waiter/sessions/' + entry.sessionId + '/bill')
    expect(bill.status).toBe(200)
    const total = bill.body.orders.reduce((sum: number, order: any) => sum + Number(order.total_minor), 0)
    expect(total).toBeGreaterThan(0)
    const payment = await api(waiterPage, 'POST', '/api/restaurant/' + DEMO_SLUG + '/waiter/sessions/' + entry.sessionId + '/payments', {
      amount_minor: String(total), method: 'cash', reference: 'DEMO-BISTRO-PLAYWRIGHT',
    })
    expect(payment.status).toBe(201)
    if (entry.tableId === tableOne.id) {
      await waiterPage.getByRole('button', { name: 'Refresh' }).click()
      const tableCard = waiterPage.locator('.restaurant-table-card').filter({ hasText: 'Table 1' })
      await tableCard.getByRole('button', { name: 'View / print bill' }).click()
      const invoiceModal = waiterPage.locator('.restaurant-bill-modal')
      await expect(invoiceModal).toContainText('GSTIN: 29ABCDE1234F1Z5')
      await expect(invoiceModal).toContainText('FSSAI License No: 11223344556677')
      await invoiceModal.getByRole('button', { name: 'Issue GST invoice & close session' }).click()
      await expect(invoiceModal).toContainText('GST TAX INVOICE')
      await expect(invoiceModal).toContainText('CGST')
      await expect(invoiceModal).toContainText('SGST')
      await expect(invoiceModal.getByRole('button', { name: 'Print GST tax invoice' })).toBeVisible()
      await invoiceModal.getByRole('button', { name: 'Print GST tax invoice' }).click()
      await waiterPage.emulateMedia({ media: 'print' })
      await expect(invoiceModal).toBeVisible()
      await waiterPage.emulateMedia({ media: 'screen' })
      await invoiceModal.getByRole('button', { name: 'Done' }).click()
      const issued = await api(waiterPage, 'GET', '/api/restaurant/' + DEMO_SLUG + '/waiter/sessions/' + entry.sessionId + '/bill')
      expect(issued.status).toBe(200)
      expect(issued.body.invoice.invoice_number).toContain('DM/')
      expect(issued.body.invoice.seller_snapshot.gstin).toBe('29ABCDE1234F1Z5')
      expect(issued.body.invoice.seller_snapshot.fssai_license_no).toBe('11223344556677')
    } else {
      const close = await api(waiterPage, 'POST', '/api/restaurant/' + DEMO_SLUG + '/tables/' + entry.tableId + '/sessions/' + entry.sessionId + '/close')
      expect(close.status).toBe(200)
      expect(close.body.session.status).toBe('closed')
    }
  }

  expect((await api(guestOne, 'POST', '/api/restaurant/' + DEMO_SLUG + '/guest/' + tokenOne + '/reviews', {
    session_id: sessionOne.id, rating: 5, comment: 'Demo Bistro automated QA: excellent food and service.',
  })).status).toBe(201)
  expect((await api(guestTwo, 'POST', '/api/restaurant/' + DEMO_SLUG + '/guest/' + tokenTwo + '/reviews', {
    session_id: sessionTwo.id, rating: 5, comment: 'Demo Bistro automated QA: quick kitchen and waiter service.',
  })).status).toBe(201)

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const reports = await api(ownerPage, 'GET', '/api/restaurant/' + DEMO_SLUG + '/reports?from=' + today + '&to=' + today)
  expect(reports.status).toBe(200)
  expect(Number(reports.body.summary.order_count)).toBeGreaterThanOrEqual(2)
  expect(Number(reports.body.summary.sales_minor)).toBeGreaterThan(0)
  expect(reports.body.payments.some((entry: any) => entry.method === 'cash')).toBe(true)
  const reviews = await api(ownerPage, 'GET', '/api/restaurant/' + DEMO_SLUG + '/reviews')
  expect(reviews.status).toBe(200)
  expect(reviews.body.reviews.some((entry: any) => entry.comment.includes('Demo Bistro automated QA'))).toBe(true)

  await guestOneContext.context.close()
  await guestTwoContext.context.close()
  await cookContext.context.close()
  await waiterContext.context.close()
  await ownerContext.context.close()
})
