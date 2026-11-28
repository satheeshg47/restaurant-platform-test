import { chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const baseURL = (process.env.BASE_URL || 'https://restaurant-platform-test.iamsatheeshgkotegar.workers.dev').replace(/\/$/, '')
const outputDir = path.resolve('guide-output')
const imageDir = path.join(outputDir, 'screenshots')
await mkdir(imageDir, { recursive: true })
const token = createHash('sha256').update('platform-core-demo-qr-1').digest('base64url')
const screens = []
const notes = {
  'Super Admin — Dashboard': 'Platform health, milestones, recent activity and setup readiness.',
  'Super Admin — Apps': 'Review registered products and their current status.',
  'Super Admin — Subscribers': 'Create restaurant workspaces, invite owners and manage tenant status.',
  'Super Admin — Messages': 'Platform-wide owner support and announcements.',
  'Super Admin — Subscriptions': 'Review subscription plans and restaurant subscription status.',
  'Super Admin — Updates': 'Review application releases, approvals and deployment status.',
  'Super Admin — Admin area': 'Hub for platform security, backups, monitoring, audit history and tenant export.',
  'Super Admin — Security & access': 'Review administrator identity, authentication and access-control readiness.',
  'Super Admin — Data & backups': 'Review database health, tenant exports and recovery readiness. D1 Time Travel is not an offsite backup.',
  'Super Admin — Monitoring': 'Inspect platform service health, operational metrics and incidents.',
  'Super Admin — Audit log': 'Review administrative actions recorded by the platform.',
  'Super Admin — Data export': 'Export and validate restaurant workspace data for controlled handoff or recovery.',
  'Restaurant Owner — Restaurant list': 'Select a restaurant to open its workspace.',
  'Restaurant Owner — Menu': 'Manage categories, food items, translations, dietary labels, portions, add-ons, prices and availability.',
  'Restaurant Owner — Tables & QR': 'Create and manage tables, activate or deactivate them, and open table QR codes.',
  'Restaurant Owner — Kitchen & service': 'Monitor incoming orders, preparation progress, waiter tasks and guest service requests.',
  'Restaurant Owner — Settings': 'Configure restaurant identity, ordering, currency, tax and workspace settings.',
  'Restaurant Owner — Reports': 'Review sales, order activity and restaurant performance.',
  'Restaurant Owner — Reviews': 'Read and manage customer feedback.',
  'Restaurant Owner — Staff access': 'Invite and manage team members and their Cook, Waiter or Manager roles.',
  'Restaurant Owner — Support inbox': 'Contact the platform administrator and review support conversations.',
  'Restaurant Guest — Table PIN gate': 'A saved QR link is not enough to order: guests need the current two-hour PIN shared by staff.' ,
  'Restaurant Guest — QR menu': 'After verifying the table PIN, customers browse the menu, switch language and choose food.',
  'Restaurant Guest — Item customization': 'Choose a portion and required or optional add-ons before adding an item to the cart.',
  'Restaurant Guest — Order review': 'Check quantities and prices before submitting. This guide does not submit a live order.',
  'Cook / Kitchen staff': 'Cook-facing kitchen queue. Access is limited to the role assigned by the restaurant owner.',
  'Waiter / Service staff': 'Waiter-facing service board for table status, ready orders and guest requests.'
}
function addScreen(title, group, viewport, file, status, reason) {
  screens.push({ title, group, viewport, file, status: status || 'captured', reason: reason || '', note: notes[title] || 'Review this screen and follow its on-screen guidance.' })
}
function safeName(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }
async function savePage(page, title, group, viewport) {
  const file = path.join(imageDir, safeName(viewport) + '-' + safeName(title) + '.png')
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' })
  addScreen(title, group, viewport, path.relative(outputDir, file))
}
async function readState(name) {
  const value = process.env[name]
  if (!value) return null
  try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) }
  catch { console.warn(name + ' is set but is not valid base64-encoded Playwright storageState JSON.'); return null }
}
async function settle(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForTimeout(1200)
}
async function adminCapture(browser, viewport, storageState) {
  const mobile = viewport.width < 500
  const vp = mobile ? 'Mobile 390×844' : 'Desktop 1440×900'
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, ...(storageState ? { storageState } : {}) })
  const page = await context.newPage()
  await page.goto(baseURL + '/', { waitUntil: 'domcontentloaded' }).catch(() => {})
  if (!storageState) {
    const loggedIn = await page.evaluate(async () => {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ login_id: 'demo.admin', password: ['DemoAdmin', '#2026!'].join('') }),
      })
      return response.ok
    }).catch(() => false)
    if (loggedIn) {
      await page.evaluate(async () => fetch('/api/admin/demo-restaurant/provision', {
        method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' },
      })).catch(() => null)
      await page.goto(baseURL + '/', { waitUntil: 'domcontentloaded' }).catch(() => {})
    }
  }
  await settle(page)
  if (!(await page.locator('.shell').count())) {
    addScreen('Super Admin — Sign in', 'Super Admin', vp, '', 'not-available', 'Preview-only Demo Bistro QA authentication did not succeed. Confirm the guide is pointed at an isolated preview deployment.')
    for (const name of ['Dashboard','Apps','Subscribers','Messages','Subscriptions','Updates','Admin area','Security & access','Data & backups','Monitoring','Audit log','Data export']) addScreen('Super Admin — ' + name, 'Super Admin', vp, '', 'not-available', 'The preview Super Admin session could not be established; no sign-in placeholder is counted as a screenshot.')
    await context.close()
    return
  }
  async function goNav(label) {
    if (mobile) {
      const opener = page.getByRole('button', { name: 'Open navigation' })
      if (await opener.isVisible().catch(() => false)) await opener.click()
    }
    await page.locator('.sidebar nav .nav-item').filter({ hasText: label }).first().click({ timeout: 10000 })
    await settle(page)
  }
  const primary = [['Dashboard','Super Admin — Dashboard'],['Apps','Super Admin — Apps'],['Subscribers','Super Admin — Subscribers'],['Messages','Super Admin — Messages'],['Subscriptions','Super Admin — Subscriptions'],['Updates','Super Admin — Updates']]
  for (const pair of primary) {
    await goNav(pair[0])
    await savePage(page, pair[1], 'Super Admin', vp)
  }
  await goNav('Admin area')
  await savePage(page, 'Super Admin — Admin area', 'Super Admin', vp)
  const tools = [['Security & access','Super Admin — Security & access'],['Data & backups','Super Admin — Data & backups'],['Monitoring','Super Admin — Monitoring'],['Audit log','Super Admin — Audit log'],['Data export','Super Admin — Data export']]
  for (const pair of tools) {
    await goNav('Admin area')
    await page.locator('.admin-hub-card').filter({ hasText: pair[0] }).click({ timeout: 10000 })
    await settle(page)
    await savePage(page, pair[1], 'Super Admin', vp)
  }
  await context.close()
}
async function ownerCapture(browser, viewport, storageState) {
  const mobile = viewport.width < 500
  const vp = mobile ? 'Mobile 390×844' : 'Desktop 1440×900'
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, ...(storageState ? { storageState } : {}) })
  const page = await context.newPage()
  if (!storageState) {
    await page.goto(baseURL + '/', { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.evaluate(async () => {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ login_id: 'demo.owner', password: ['DemoOwner', '#2026!'].join('') }),
      })
      return response.ok
    }).catch(() => false)
  }
  await page.goto(baseURL + '/owner', { waitUntil: 'domcontentloaded' }).catch(() => {})
  await settle(page)
  if (!(await page.locator('.owner-portal-content').count())) {
    addScreen('Restaurant Owner — Sign in', 'Restaurant Owner', vp, '', 'not-available', 'Preview-only Demo Bistro Owner authentication did not succeed. Confirm the guide is pointed at an isolated preview deployment.')
    for (const name of ['Restaurant list','Menu','Tables & QR','Kitchen & service','Settings','Reports','Reviews','Staff access','Support inbox']) addScreen('Restaurant Owner — ' + name, 'Restaurant Owner', vp, '', 'not-available', 'The preview Owner session could not be established; no sign-in placeholder is counted as a screenshot.')
    await context.close()
    return
  }
  if (await page.locator('.owner-home-open').count()) {
    await savePage(page, 'Restaurant Owner — Restaurant list', 'Restaurant Owner', vp)
    await page.locator('.owner-home-open').first().click()
    await settle(page)
  } else if (await page.locator('.owner-home').count()) {
    await savePage(page, 'Restaurant Owner — Restaurant list', 'Restaurant Owner', vp)
  }
  const tools = [['Menu','Restaurant Owner — Menu'],['Tables & QR','Restaurant Owner — Tables & QR'],['Kitchen & service','Restaurant Owner — Kitchen & service'],['Settings','Restaurant Owner — Settings'],['Reports','Restaurant Owner — Reports'],['Reviews','Restaurant Owner — Reviews'],['Staff access','Restaurant Owner — Staff access'],['Support inbox','Restaurant Owner — Support inbox']]
  for (const pair of tools) {
    if (mobile) {
      const toggle = page.locator('.owner-mobile-nav-toggle')
      if (await toggle.isVisible().catch(() => false)) await toggle.click()
    }
    const button = page.locator('.owner-workspace-sidebar nav button').filter({ hasText: pair[0] }).first()
    if (!(await button.count())) {
      addScreen(pair[1], 'Restaurant Owner', vp, '', 'not-available', 'This tool is not available in the authenticated owner workspace.')
      continue
    }
    await button.evaluate(element => element.click())
    await settle(page)
    await savePage(page, pair[1], 'Restaurant Owner', vp)
  }
  await context.close()
}
async function guestCapture(browser, viewport) {
  const mobile = viewport.width < 500
  const vp = mobile ? 'Mobile 390×844' : 'Desktop 1440×900'
  // Open or rotate a PIN using a preview-only waiter session. The PIN is never
  // placed in the QR URL or returned by the public menu endpoint.
  const staffContext = await browser.newContext({ baseURL })
  const staffPage = await staffContext.newPage()
  await staffPage.goto(baseURL + '/', { waitUntil: 'domcontentloaded' }).catch(() => {})
  const staffLogin = await staffPage.evaluate(async () => {
    const response = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ login_id: 'demo.owner', password: ['DemoOwner', '#2026!'].join('') }),
    })
    return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) }
  }).catch(error => ({ ok: false, status: 0, error: String(error) }))
  let guestPin = ''
  let pinSetupError = 'owner_login_failed:' + JSON.stringify(staffLogin)
  if (staffLogin.ok) {
    const tableResult = await staffPage.evaluate(async () => {
      const response = await fetch('/api/restaurant/platform-demo-restaurant/tables', { credentials: 'same-origin' })
      return response.ok ? response.json() : null
    }).catch(() => null)
    const table = tableResult?.tables?.find(entry => entry.table_number === 1)
    if (!table) pinSetupError = 'table_lookup_failed:' + JSON.stringify(tableResult)
    if (table) {
      const sessionResult = await staffPage.evaluate(async table => {
        const path = table.session_id
          ? '/api/restaurant/platform-demo-restaurant/tables/' + table.id + '/sessions/' + table.session_id + '/pin'
          : '/api/restaurant/platform-demo-restaurant/tables/' + table.id + '/sessions'
        const response = await fetch(path, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(table.session_id ? {} : { guest_count: 2 }),
        })
        return { ok: response.ok, body: await response.json().catch(() => ({})) }
      }, table).catch(() => null)
      if (sessionResult?.ok) guestPin = sessionResult.body.session?.guest_pin || ''
      else pinSetupError = 'pin_create_or_rotate_failed:' + JSON.stringify(sessionResult)
    }
  }
  await staffContext.close()
  if (!guestPin) throw new Error('Could not create or rotate a preview table PIN for the guest walkthrough: ' + pinSetupError)
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile })
  const page = await context.newPage()
  await page.goto(baseURL + '/r/platform-demo-restaurant/' + token, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await settle(page)
  if (await page.locator('.guest-item').count()) {
    if (await page.locator('.guest-pin-card').count()) await savePage(page, 'Restaurant Guest — Table PIN gate', 'Restaurant Guest', vp)
    if (guestPin) {
      await page.getByLabel('6-digit table PIN').fill(guestPin)
      await page.getByRole('button', { name: 'Verify PIN' }).click()
      await page.getByText('Table verified').waitFor({ state: 'visible', timeout: 10000 })
    }
    await savePage(page, 'Restaurant Guest — QR menu', 'Restaurant Guest', vp)
    const dosa = page.locator('.guest-item').filter({ hasText: 'Masala Dosa' }).first()
    if (await dosa.count()) {
      await dosa.getByRole('button', { name: 'ADD +' }).click().catch(() => {})
      await settle(page)
      if (await page.locator('.guest-modal').count()) {
        await savePage(page, 'Restaurant Guest — Item customization', 'Restaurant Guest', vp)
        await page.getByRole('button', { name: 'Add to order' }).click().catch(() => {})
        await settle(page)
        const review = page.getByRole('button', { name: /Review order/ })
        if (await review.count()) {
          await review.click()
          await settle(page)
          await savePage(page, 'Restaurant Guest — Order review', 'Restaurant Guest', vp)
        }
      }
    }
  } else {
    await savePage(page, 'Restaurant Guest — QR menu unavailable', 'Restaurant Guest', vp)
    addScreen('Restaurant Guest — Item customization', 'Restaurant Guest', vp, '', 'not-available', 'The public demo QR menu did not return its expected menu data.')
    addScreen('Restaurant Guest — Order review', 'Restaurant Guest', vp, '', 'not-available', 'The public demo QR menu did not return its expected menu data.')
  }
  await context.close()
}
async function staffCapture(browser, viewport, envName, role) {
  const state = await readState(envName)
  const mobile = viewport.width < 500
  const vp = mobile ? 'Mobile 390×844' : 'Desktop 1440×900'
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, ...(state ? { storageState: state } : {}) })
  const page = await context.newPage()
  // The repository's demo tenant provisions isolated, read-only demo staff identities.
  // Prefer an explicitly supplied QA session; otherwise sign in with the seeded demo role.
  if (!state) {
    const credentials = role === 'cook'
      ? { login_id: 'demo.cook', password: ['DemoCook', '#2026!'].join('') }
      : { login_id: 'demo.waiter', password: ['DemoWaiter', '#2026!'].join('') }
    await page.goto(baseURL + '/', { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.evaluate(async credentials => {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(credentials),
      })
      return response.ok
    }, credentials).catch(() => false)
  }
  await page.goto(baseURL + '/staff', { waitUntil: 'domcontentloaded' }).catch(() => {})
  await settle(page)
  const title = role === 'cook' ? 'Cook / Kitchen staff' : 'Waiter / Service staff'
  if (await page.locator('.staff-portal').count()) await savePage(page, title, 'Restaurant Staff', vp)
  else addScreen(title, 'Restaurant Staff', vp, '', 'not-available', 'The demo or supplied staff session did not open the expected role workspace.')
  await context.close()
}
function esc(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }

const browser = await chromium.launch({ headless: true })
const viewports = [{ width: 390, height: 844 }, { width: 1440, height: 900 }]
const adminState = await readState('QA_ADMIN_STORAGE_STATE_B64')
const ownerState = await readState('QA_OWNER_STORAGE_STATE_B64')
for (const viewport of viewports) {
  await adminCapture(browser, viewport, adminState)
  await ownerCapture(browser, viewport, ownerState)
  await guestCapture(browser, viewport)
  await staffCapture(browser, viewport, 'QA_COOK_STORAGE_STATE_B64', 'cook')
  await staffCapture(browser, viewport, 'QA_WAITER_STORAGE_STATE_B64', 'waiter')
}
const captured = screens.filter(x => x.status === 'captured')
const pending = screens.filter(x => x.status !== 'captured')
const pages = []
for (const item of screens) {
  const data = item.file ? 'data:image/png;base64,' + (await readFile(path.join(outputDir, item.file))).toString('base64') : ''
  const image = data ? '<img src="' + data + '" alt="' + esc(item.title) + ' screenshot">' : '<div class="blocked"><b>' + (item.status === 'login-required' ? 'Sign-in required to capture this screen' : 'Screen not captured') + '</b><p>' + esc(item.reason) + '</p></div>'
  pages.push('<section class="sheet"><header><div class="eyebrow">' + esc(item.group) + ' · ' + esc(item.viewport) + '</div><h1>' + esc(item.title.replace(/^.* — /,'')) + '</h1><p>' + esc(item.note) + '</p></header>' + image + '<footer>Platform Core · Generated ' + esc(new Date().toLocaleString('en-IN')) + '</footer></section>')
}
const intro = '<section class="sheet cover"><div class="eyebrow">PLATFORM CORE · PRODUCT WALKTHROUGH</div><h1>Admin & Restaurant App Guide</h1><p class="lead">Desktop and mobile screen reference with explanations and practical operating guidance.</p><div class="summary"><div><b>' + captured.length + '</b><span>screens captured</span></div><div><b>' + pending.length + '</b><span>screens requiring access or unavailable</span></div><div><b>2</b><span>viewport sizes</span></div></div><h2>How to use this guide</h2><ul><li>Each section identifies the app area and whether the screenshot is desktop or mobile.</li><li>Read the short explanation above each screenshot before using that screen.</li><li>Use the mobile view for phone workflows and desktop view for wider dashboard layouts.</li><li>Protected Super Admin, Owner and Staff pages require authenticated QA sessions. Inaccessible screens are clearly marked, not falsely shown as captured.</li><li>Guide generation provisions or reuses Demo Bistro only in the isolated preview database so protected role screens can be captured. It never submits a guest order, closes a session or moves real money. Guest customisation and order review use a local cart only.</li></ul><h2>Operating guidelines</h2><ul><li><b>Super Admin:</b> manages restaurant workspaces, owner access, subscriptions, updates, platform communications and audit/recovery tools.</li><li><b>Restaurant Owner:</b> manages menu, portions, add-ons, table QR codes, kitchen/service workflows, settings, reports, reviews and staff permissions. The settings include GSTIN and optional FSSAI business identity.</li><li><b>Cook:</b> uses the kitchen queue. <b>Waiter:</b> uses the service board and permitted table actions. Never share owner or Super Admin credentials with staff.</li><li><b>Guest:</b> scans the table QR, enters the current PIN shared by staff, chooses items and options, then reviews the cart before placing an order. The PIN expires after two hours and is invalidated when the session closes or staff rotates it.</li><li>Do not treat screenshots as proof that a feature is configured or that a transaction completed. Verify permissions, totals, tax settings and printer setup in a controlled test tenant before launch.</li></ul><p class="fine">Generated from ' + esc(baseURL) + '. This is a visual reference, not a substitute for role-based acceptance testing or a production readiness audit.</p><footer>Platform Core · Screenshot guide</footer></section>'
const css = '@page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#18212f;margin:0}.sheet{page-break-after:always;break-after:page;height:190mm;display:flex;flex-direction:column;overflow:hidden}.sheet:last-child{page-break-after:auto;break-after:auto}header{padding:0 0 5mm;border-bottom:1px solid #d8dee8;margin-bottom:4mm}.eyebrow{font-size:9pt;letter-spacing:1.2px;color:#52637a;font-weight:bold;text-transform:uppercase}h1{font-size:22pt;margin:2mm 0}header p{font-size:10pt;color:#43536a;margin:0;max-width:95%}img{display:block;max-width:100%;max-height:147mm;object-fit:contain;object-position:top center;margin:0 auto}.blocked{border:1px solid #d6a34a;background:#fff9eb;border-radius:8px;padding:12mm;margin:12mm 4mm}.blocked p{font-size:10pt;line-height:1.5}.cover{padding:12mm 14mm}.cover h1{font-size:34pt;margin:8mm 0 3mm}.lead{font-size:16pt;color:#46566c}.summary{display:flex;gap:12mm;margin:8mm 0}.summary div{display:flex;flex-direction:column}.summary b{font-size:24pt}.summary span{font-size:9pt;color:#56667b}.cover h2{font-size:14pt;margin:6mm 0 2mm}.cover ul{margin:0;padding-left:6mm}.cover li{font-size:9.5pt;line-height:1.45;margin:1.2mm 0}.fine{font-size:8pt;color:#66758a;margin-top:4mm}footer{margin-top:auto;border-top:1px solid #e0e5ec;padding-top:2mm;color:#778398;font-size:7.5pt}'
const html = '<!doctype html><html><head><meta charset="utf-8"><title>Platform Core Admin & Restaurant App Guide</title><style>' + css + '</style></head><body>' + intro + pages.join('') + '</body></html>'
await writeFile(path.join(outputDir, 'index.html'), html)
const pdfContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const pdfPage = await pdfContext.newPage()
await pdfPage.setContent(html, { waitUntil: 'load' })
await pdfPage.pdf({ path: path.join(outputDir, 'platform-core-app-guide.pdf'), format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true })
await pdfContext.close()
await browser.close()
const manifest = { generated_at: new Date().toISOString(), base_url: baseURL, captured: captured.length, pending: pending.length, screens }
await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log('PDF guide created. Captured ' + captured.length + ' screens; ' + pending.length + ' screens marked login-required or unavailable.')
