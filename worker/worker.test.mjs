import test, { before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import worker from './index.ts'

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.values = [] }
  bind(...values) { this.values = values; return this }
  all() {
    const results = this.db.prepare(this.sql).all(...this.values)
    const meta = this.db.prepare('SELECT changes() AS changes').get()
    return { results, success: true, meta: { changes: Number(meta.changes) } }
  }
  first() { return this.db.prepare(this.sql).get(...this.values) ?? null }
  run() {
    const result = this.db.prepare(this.sql).run(...this.values)
    return { results: [], success: true, meta: { changes: Number(result.changes) } }
  }
}

function d1(db) {
  return {
    prepare(sql) { return new Statement(db, sql) },
    batch(statements) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map(statement => statement.all())
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

let privateKey
let jwksServer
let issuer
let jwksUrl
let env
let db
let tenantId
const audience = 'https://platform-core-api'
const clientId = 'PZuFV2NqKcO0yVvwTIHNWSkt8EWl19CX'
const adminSubject = 'auth0|platform-admin'

before(async () => {
  const keys = await generateKeyPair('RS256', { modulusLength: 2048 })
  privateKey = keys.privateKey
  const jwk = await exportJWK(keys.publicKey)
  Object.assign(jwk, { kid: 'worker-test-key', alg: 'RS256', use: 'sig' })
  jwksServer = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' })
    response.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise(resolve => jwksServer.listen(0, '127.0.0.1', resolve))
  const address = jwksServer.address()
  issuer = `http://127.0.0.1:${address.port}/`
  jwksUrl = `http://127.0.0.1:${address.port}/.well-known/jwks.json`
})

after(async () => {
  if (jwksServer) await new Promise(resolve => jwksServer.close(resolve))
})

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(readFileSync('database/d1/migrations/0001_platform_core.sql', 'utf8'))
  db.exec(readFileSync('database/d1/migrations/0002_owner_communication_centre.sql', 'utf8'))
  db.exec(readFileSync('database/d1/migrations/0003_restaurant_domain.sql', 'utf8'))
  db.exec(readFileSync('database/d1/migrations/0004_restaurant_order_item_timing.sql', 'utf8'))
  db.exec(readFileSync('database/d1/migrations/0005_seed_restaurant_application.sql', 'utf8'))
  tenantId = crypto.randomUUID()
  db.prepare('INSERT INTO tenants(id,name,slug,status) VALUES(?,?,?,?)').run(tenantId, 'Test Restaurant', 'test-restaurant', 'active')
  env = {
    DB: d1(db),
    ASSETS: { fetch: async () => new Response('asset') },
    OIDC_ISSUER: issuer,
    OIDC_AUDIENCE: audience,
    OIDC_CLIENT_ID: clientId,
    OIDC_JWKS_URL: jwksUrl,
    PLATFORM_ADMIN_SUBJECT: adminSubject,
    ENVIRONMENT: 'test',
  }
})

afterEach(() => { db?.close() })

async function token(subject, aud, claims = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'worker-test-key' })
    .setIssuer(issuer)
    .setAudience(aud)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

async function call(path, { method = 'GET', accessToken, idToken, body } = {}) {
  const headers = new Headers({ Accept: 'application/json' })
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  if (idToken) headers.set('X-OIDC-ID-Token', idToken)
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  return worker.fetch(new Request(`https://platform.test/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
}

test('D1 health, readiness and protected Super Admin session work', async () => {
  const health = await call('/health')
  assert.equal(health.status, 200)
  assert.equal((await health.json()).service, 'platform-core-api')

  const ready = await call('/ready')
  assert.equal(ready.status, 200)

  const unauthorized = await call('/admin/session')
  assert.equal(unauthorized.status, 401)

  const adminToken = await token(adminSubject, audience)
  const session = await call('/admin/session', { accessToken: adminToken })
  assert.equal(session.status, 200)
  assert.equal((await session.json()).admin.subject, adminSubject)

  const app = await call('/admin/applications', {
    method: 'POST', accessToken: adminToken, body: { app_key: 'test-app', name: 'Test App' },
  })
  assert.equal(app.status, 201)
  assert.equal(db.prepare('SELECT count(*) AS count FROM platform_audit_events').get().count, 1)
})

test('owner invitation requires matching verified identity and creates one active owner', async () => {
  const adminToken = await token(adminSubject, audience)
  const created = await call('/admin/owner-invitations', {
    method: 'POST', accessToken: adminToken,
    body: { tenant_id: tenantId, email: 'owner@example.com' },
  })
  assert.equal(created.status, 201)
  const invitation = await created.json()
  assert.match(invitation.token, /^[A-Za-z0-9_-]{43}$/)

  const ownerSubject = 'auth0|restaurant-owner'
  const ownerAccess = await token(ownerSubject, audience)
  const wrongEmailId = await token(ownerSubject, clientId, { email: 'wrong@example.com', email_verified: true })
  const mismatch = await call('/owner/invitations/accept', {
    method: 'POST', accessToken: ownerAccess, idToken: wrongEmailId, body: { token: invitation.token },
  })
  assert.equal(mismatch.status, 403)
  assert.equal(db.prepare('SELECT status FROM platform_owner_invitations').get().status, 'pending')

  const ownerId = await token(ownerSubject, clientId, { email: 'owner@example.com', email_verified: true })
  const accepted = await call('/owner/invitations/accept', {
    method: 'POST', accessToken: ownerAccess, idToken: ownerId, body: { token: invitation.token },
  })
  assert.equal(accepted.status, 200)
  assert.equal((await accepted.json()).accepted, true)
  assert.equal(db.prepare("SELECT count(*) AS count FROM tenant_memberships WHERE tenant_id=? AND role='owner' AND status='active'").get(tenantId).count, 1)
  assert.equal(db.prepare('SELECT status FROM platform_owner_invitations').get().status, 'accepted')

  const duplicate = await call('/admin/owner-invitations', {
    method: 'POST', accessToken: adminToken,
    body: { tenant_id: tenantId, email: 'second@example.com' },
  })
  assert.equal(duplicate.status, 409)
})

test('owner support conversations and admin replies are tenant-scoped', async () => {
  const adminToken = await token(adminSubject, audience)
  const inviteResponse = await call('/admin/owner-invitations', {
    method: 'POST', accessToken: adminToken,
    body: { tenant_id: tenantId, email: 'owner@example.com' },
  })
  const invite = await inviteResponse.json()
  const ownerSubject = 'auth0|owner-support'
  const ownerAccess = await token(ownerSubject, audience)
  const ownerId = await token(ownerSubject, clientId, { email: 'owner@example.com', email_verified: true })
  const accepted = await call('/owner/invitations/accept', {
    method: 'POST', accessToken: ownerAccess, idToken: ownerId, body: { token: invite.token },
  })
  assert.equal(accepted.status, 200)

  const created = await call('/owner/communications', {
    method: 'POST', accessToken: ownerAccess,
    body: { subject: 'Need help', message: 'Please help with setup.' },
  })
  assert.equal(created.status, 201)
  const conversationId = (await created.json()).message.conversation_id

  const adminInbox = await call('/admin/communications', { accessToken: adminToken })
  assert.equal(adminInbox.status, 200)
  assert.equal((await adminInbox.json()).conversations.length, 1)

  const reply = await call(`/admin/communications/${conversationId}/messages`, {
    method: 'POST', accessToken: adminToken, body: { message: 'We can help.' },
  })
  assert.equal(reply.status, 201)

  const ownerMessages = await call(`/owner/communications/${conversationId}`, { accessToken: ownerAccess })
  assert.equal(ownerMessages.status, 200)
  const messages = (await ownerMessages.json()).messages
  assert.equal(messages.length, 2)
  assert.equal(messages[1].body, 'We can help.')

  const ownerTenants = await call('/owner/communications/tenants', { accessToken: ownerAccess })
  assert.equal(ownerTenants.status, 200)
  assert.equal((await ownerTenants.json()).tenants.length, 1)

  const denied = await call(`/owner/communications/${crypto.randomUUID()}`, { accessToken: ownerAccess })
  assert.equal(denied.status, 404)
})

test('admin announcements reach only selected active owners', async () => {
  const adminToken = await token(adminSubject, audience)
  const inviteResponse = await call('/admin/owner-invitations', {
    method: 'POST', accessToken: adminToken,
    body: { tenant_id: tenantId, email: 'owner@example.com' },
  })
  const invite = await inviteResponse.json()
  const ownerSubject = 'auth0|owner-announcement'
  const ownerAccess = await token(ownerSubject, audience)
  const ownerId = await token(ownerSubject, clientId, { email: 'owner@example.com', email_verified: true })
  const accepted = await call('/owner/invitations/accept', {
    method: 'POST', accessToken: ownerAccess, idToken: ownerId, body: { token: invite.token },
  })
  assert.equal(accepted.status, 200)
  const owner = db.prepare('SELECT id FROM platform_users WHERE auth_subject=?').get(ownerSubject)

  const broadcast = await call('/admin/communications', {
    method: 'POST', accessToken: adminToken,
    body: { kind: 'announcement', subject: 'Service update', message: 'A scheduled update.', user_ids: [owner.id] },
  })
  assert.equal(broadcast.status, 201)

  const inbox = await call('/owner/communications', { accessToken: ownerAccess })
  assert.equal(inbox.status, 200)
  const conversations = (await inbox.json()).conversations
  assert.equal(conversations.length, 1)
  assert.equal(conversations[0].kind, 'announcement')
})

test('D1 restaurant schema includes tenant-scoped operations, GST invoices and item timing', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'restaurant_%' ORDER BY name").all().map(row => row.name)
  assert.equal(tables.length, 25)
  for (const table of ['restaurant_profiles','restaurant_staff','restaurant_tables','restaurant_table_sessions','restaurant_menu_categories','restaurant_menu_items','restaurant_orders','restaurant_order_items','restaurant_kitchen_batches','restaurant_payments','restaurant_refunds','restaurant_service_requests','restaurant_reviews','restaurant_invoice_counters','restaurant_invoices']) {
    assert.ok(tables.includes(table), `missing ${table}`)
  }
  const itemColumns = db.prepare('PRAGMA table_info(restaurant_order_items)').all().map(row => row.name)
  for (const column of ['preparation_started_at','ready_at','served_at','unavailable_at','cancelled_at']) {
    assert.ok(itemColumns.includes(column), `missing order-item timing column ${column}`)
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('Super Admin can create a tenant, invite its owner and manage restaurant settings and tables', async () => {
  const adminToken = await token(adminSubject, audience)
  const created = await call('/admin/tenants', {
    method: 'POST', accessToken: adminToken,
    body: { name: 'Green Leaf Kitchen', slug: 'green-leaf-kitchen' },
  })
  assert.equal(created.status, 201)
  const tenant = (await created.json()).tenant
  assert.equal(tenant.slug, 'green-leaf-kitchen')
  assert.equal(db.prepare("SELECT count(*) AS count FROM tenant_applications WHERE tenant_id=? AND status='active'").get(tenant.id).count, 1)
  assert.equal(db.prepare('SELECT display_name FROM restaurant_profiles WHERE tenant_id=?').get(tenant.id).display_name, 'Green Leaf Kitchen')

  const inviteResponse = await call('/admin/owner-invitations', {
    method: 'POST', accessToken: adminToken,
    body: { tenant_id: tenant.id, email: 'tenant-owner@example.com' },
  })
  assert.equal(inviteResponse.status, 201)
  const invite = await inviteResponse.json()
  const ownerSubject = 'auth0|tenant-owner'
  const ownerAccess = await token(ownerSubject, audience)
  const ownerId = await token(ownerSubject, clientId, { email: 'tenant-owner@example.com', email_verified: true })
  const accepted = await call('/owner/invitations/accept', {
    method: 'POST', accessToken: ownerAccess, idToken: ownerId, body: { token: invite.token },
  })
  assert.equal(accepted.status, 200)

  const settings = await call('/restaurant/green-leaf-kitchen/settings', { accessToken: ownerAccess })
  assert.equal(settings.status, 200)
  assert.equal((await settings.json()).settings.display_name, 'Green Leaf Kitchen')

  const saved = await call('/restaurant/green-leaf-kitchen/settings', {
    method: 'PATCH', accessToken: ownerAccess,
    body: {
      display_name: 'Green Leaf Foods', currency_code: 'INR', timezone: 'Asia/Kolkata',
      default_language: 'kn', tax_mode: 'gst', tax_rate: 0, gst_rate: 5,
      tax_inclusive: false, accepting_orders: true, legal_name: 'Green Leaf Foods Pvt Ltd',
      gstin: '29ABCDE1234F1Z5', address_line1: '123 Main Street', address_line2: '',
      city: 'Bengaluru', state_name: 'Karnataka', state_code: '29', postal_code: '560001',
      invoice_prefix: 'GLF',
    },
  })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).settings.gstin, '29ABCDE1234F1Z5')

  const tableResponse = await call('/restaurant/green-leaf-kitchen/tables', {
    method: 'POST', accessToken: ownerAccess,
    body: { label: 'Table 1', table_type: 'dine_in', table_number: 1 },
  })
  assert.equal(tableResponse.status, 201)
  const table = await tableResponse.json()
  assert.match(table.qr_token, /^[A-Za-z0-9_-]{43}$/)

  const opened = await call(`/restaurant/green-leaf-kitchen/tables/${table.table.id}/sessions`, {
    method: 'POST', accessToken: ownerAccess, body: { guest_count: 4 },
  })
  assert.equal(opened.status, 201)
  const session = (await opened.json()).session

  const orderId = crypto.randomUUID()
  db.prepare(`INSERT INTO restaurant_orders(id,tenant_id,order_number,table_id,session_id,status,subtotal_minor,tax_minor,total_minor,source,idempotency_key)
    VALUES(?,?,?,?,?,'new',100,0,100,'qr',?)`).run(orderId, tenant.id, 1, table.table.id, session.id, 'session-test-order')
  const blockedUnfinished = await call(`/restaurant/green-leaf-kitchen/tables/${table.table.id}/sessions/${session.id}/close`, {
    method: 'POST', accessToken: ownerAccess,
  })
  assert.equal(blockedUnfinished.status, 409)
  assert.equal((await blockedUnfinished.json()).error, 'orders_not_completed')
  db.prepare("UPDATE restaurant_orders SET status='served' WHERE tenant_id=? AND id=?").run(tenant.id, orderId)
  const blockedUnpaid = await call(`/restaurant/green-leaf-kitchen/tables/${table.table.id}/sessions/${session.id}/close`, {
    method: 'POST', accessToken: ownerAccess,
  })
  assert.equal(blockedUnpaid.status, 409)
  assert.equal((await blockedUnpaid.json()).error, 'payment_due')
  db.prepare(`INSERT INTO restaurant_payments(tenant_id,session_id,table_id,amount_minor,method)
    VALUES(?,?,?,100,'cash')`).run(tenant.id, session.id, table.table.id)

  const qrMenu = await call(`/restaurant/green-leaf-kitchen/guest/${table.qr_token}/menu`)
  assert.equal(qrMenu.status, 200)
  const guestData = await qrMenu.json()
  assert.equal(guestData.table.id, table.table.id)
  assert.equal(guestData.session.id, session.id)
  assert.equal(guestData.restaurant.display_name, 'Green Leaf Foods')

  const closed = await call(`/restaurant/green-leaf-kitchen/tables/${table.table.id}/sessions/${session.id}/close`, {
    method: 'POST', accessToken: ownerAccess,
  })
  assert.equal(closed.status, 200)
  assert.equal((await closed.json()).session.status, 'closed')

  const tableList = await call('/restaurant/green-leaf-kitchen/tables', { accessToken: ownerAccess })
  assert.equal(tableList.status, 200)
  assert.equal((await tableList.json()).tables[0].session_id, null)

  const otherTenant = await call('/admin/tenants', { method: 'POST', accessToken: adminToken, body: { name: 'Other Tenant', slug: 'other-tenant' } })
  assert.equal(otherTenant.status, 201)
  const forbidden = await call('/restaurant/other-tenant/settings', { accessToken: ownerAccess })
  assert.equal(forbidden.status, 403)
})
