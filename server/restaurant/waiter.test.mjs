import test from 'node:test'
import assert from 'node:assert/strict'
import { handleGuestLifecycle, handleWaiterRoutes } from './waiter.mjs'

function fakeResponse() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(body) },
  }
}

test('guest lifecycle endpoints reject malformed QR tokens before database access', async () => {
  let connected = false
  const response = fakeResponse()
  await handleGuestLifecycle(
    { method: 'GET' }, response,
    { database: { connect: async () => { connected = true } }, tenantId: '123e4567-e89b-42d3-a456-426614174000', token: 'bad-token', parts: ['restaurant','demo','guest','bad-token','orders','123e4567-e89b-42d3-a456-426614174001'] },
  )
  assert.equal(response.status, 404)
  assert.deepEqual(response.body, { error: 'qr_not_found' })
  assert.equal(connected, false)
})

test('cooks cannot access waiter board operations', async () => {
  const response = fakeResponse()
  await handleWaiterRoutes(
    { method: 'GET' }, response,
    { database: {}, tenantId: '123e4567-e89b-42d3-a456-426614174000', actor: { role: 'cook' }, parts: ['restaurant','demo','waiter','board'] },
  )
  assert.equal(response.status, 403)
  assert.deepEqual(response.body, { error: 'restaurant_role_forbidden' })
})

test('waiter serve route rejects malformed item IDs without connecting to the database', async () => {
  let connected = false
  const response = fakeResponse()
  await handleWaiterRoutes(
    { method: 'POST' }, response,
    { database: { connect: async () => { connected = true } }, tenantId: '123e4567-e89b-42d3-a456-426614174000', actor: { role: 'waiter' }, parts: ['restaurant','demo','waiter','items','bad-id','serve'] },
  )
  assert.equal(response.status, 404)
  assert.deepEqual(response.body, { error: 'order_item_not_found' })
  assert.equal(connected, false)
})

test('waiter session bill returns tenant-scoped order lines and payment history', async () => {
  const calls = []
  const client = {
    async query(sql) {
      calls.push(sql)
      if (sql.includes('set_config')) return { rows: [] }
      if (sql.includes('FROM restaurant_table_sessions s')) return { rows: [{ id: '123e4567-e89b-42d3-a456-426614174001', table_label: 'T1', restaurant_name: 'Demo', currency_code: 'INR' }] }
      if (sql.includes('FROM restaurant_orders WHERE')) return { rows: [{ id: 'order-1', order_number: '1', subtotal_minor: '10000', tax_minor: '500', total_minor: '10500' }] }
      if (sql.includes('FROM restaurant_order_items oi')) return { rows: [{ item_name_snapshot: 'Dosa', quantity: 2, line_total_minor: '10000' }] }
      if (sql.includes('FROM restaurant_payments')) return { rows: [{ amount_minor: '5000', method: 'cash' }] }
      if (sql.includes('FROM restaurant_refunds')) return { rows: [] }
      return { rows: [] }
    },
    release() {},
  }
  const response = fakeResponse()
  const handled = await handleWaiterRoutes(
    { method: 'GET' }, response,
    { database: { connect: async () => client }, tenantId: '123e4567-e89b-42d3-a456-426614174000',
      actor: { role: 'waiter' }, parts: ['restaurant','demo','waiter','sessions','123e4567-e89b-42d3-a456-426614174001','bill'] },
  )
  assert.equal(handled, true)
  assert.equal(response.status, 200)
  assert.equal(response.body.session.table_label, 'T1')
  assert.equal(response.body.orders[0].total_minor, '10500')
  assert.equal(response.body.items[0].item_name_snapshot, 'Dosa')
  assert.equal(response.body.payments[0].amount_minor, '5000')
  assert.ok(calls.every(sql => !/WHERE\\s+id=/.test(sql) || sql.includes('tenant_id')))
})

test('session bill rejects malformed session IDs before database access', async () => {
  let connected = false
  const response = fakeResponse()
  await handleWaiterRoutes(
    { method: 'GET' }, response,
    { database: { connect: async () => { connected = true } }, tenantId: '123e4567-e89b-42d3-a456-426614174000',
      actor: { role: 'waiter' }, parts: ['restaurant','demo','waiter','sessions','bad-id','bill'] },
  )
  assert.equal(response.status, 404)
  assert.equal(connected, false)
})

test('guest can discover the latest closed visit eligible for review from the QR code', async () => {
  const response = fakeResponse()
  const queries = []
  const client = {
    async query(sql) {
      queries.push(String(sql))
      if (String(sql).includes('set_config')) return { rows: [] }
      if (String(sql).includes('SELECT id,label FROM restaurant_tables')) return { rows: [{ id: '223e4567-e89b-42d3-a456-426614174001', label: 'Table 1' }] }
      if (String(sql).includes('SELECT s.id,s.closed_at')) return { rows: [{ id: '323e4567-e89b-42d3-a456-426614174002', closed_at: '2026-11-17T12:00:00Z', already_reviewed: false }] }
      return { rows: [] }
    },
    release() {},
  }
  const token = 'A'.repeat(43)
  await handleGuestLifecycle(
    { method: 'GET' }, response,
    { database: { connect: async () => client }, tenantId: '123e4567-e89b-42d3-a456-426614174000',
      token, parts: ['restaurant','demo','guest',token,'reviews'] },
  )
  assert.equal(response.status, 200)
  assert.equal(response.body.review_session.id, '323e4567-e89b-42d3-a456-426614174002')
  assert.equal(response.body.already_reviewed, false)
  assert.ok(queries.some(sql => sql.includes("interval '30 days'")))
})

test('guest review lookup does not offer a visit that already has a review', async () => {
  const response = fakeResponse()
  const client = {
    async query(sql) {
      if (String(sql).includes('set_config')) return { rows: [] }
      if (String(sql).includes('SELECT id,label FROM restaurant_tables')) return { rows: [{ id: '223e4567-e89b-42d3-a456-426614174001', label: 'Table 1' }] }
      if (String(sql).includes('SELECT s.id,s.closed_at')) return { rows: [{ id: '323e4567-e89b-42d3-a456-426614174002', already_reviewed: true }] }
      return { rows: [] }
    },
    release() {},
  }
  const token = 'B'.repeat(43)
  await handleGuestLifecycle(
    { method: 'GET' }, response,
    { database: { connect: async () => client }, tenantId: '123e4567-e89b-42d3-a456-426614174000',
      token, parts: ['restaurant','demo','guest',token,'reviews'] },
  )
  assert.equal(response.status, 200)
  assert.equal(response.body.review_session, null)
  assert.equal(response.body.already_reviewed, true)
})
