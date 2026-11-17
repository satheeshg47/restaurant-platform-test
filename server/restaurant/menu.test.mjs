import test from 'node:test'
import assert from 'node:assert/strict'
import { handleOwnerMenuRoutes } from './menu.mjs'

const tenantId = '123e4567-e89b-42d3-a456-426614174000'

function response() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(body) },
  }
}

test('restaurant menu endpoints deny waiter and cook roles', async () => {
  for (const role of ['waiter', 'cook']) {
    const res = response()
    const handled = await handleOwnerMenuRoutes(
      { method: 'GET' }, res,
      { database: {}, tenantId, actor: { role }, parts: ['restaurant', 'demo', 'menu'] },
    )
    assert.equal(handled, true)
    assert.equal(res.status, 403)
    assert.deepEqual(res.body, { error: 'restaurant_role_forbidden' })
  }
})

test('restaurant menu endpoints deny unknown roles', async () => {
  const res = response()
  const handled = await handleOwnerMenuRoutes(
    { method: 'GET' }, res,
    { database: {}, tenantId, actor: { role: 'unknown' }, parts: ['restaurant', 'demo', 'menu'] },
  )
  assert.equal(handled, true)
  assert.equal(res.status, 403)
})

test('owner menu handler leaves unrelated restaurant paths to the router', async () => {
  const res = response()
  const handled = await handleOwnerMenuRoutes(
    { method: 'GET' }, res,
    { database: {}, tenantId, actor: { role: 'owner' }, parts: ['restaurant', 'demo', 'tables'] },
  )
  assert.equal(handled, false)
})

test('restaurant variant and add-on management deny waiter and cook roles', async () => {
  const paths = [
    ['restaurant', 'demo', 'menu', 'items', '123e4567-e89b-42d3-a456-426614174001', 'variants'],
    ['restaurant', 'demo', 'menu', 'addon-groups'],
    ['restaurant', 'demo', 'menu', 'addons', '123e4567-e89b-42d3-a456-426614174001'],
  ]
  for (const role of ['waiter', 'cook']) {
    for (const parts of paths) {
      const res = response()
      const handled = await handleOwnerMenuRoutes(
        { method: 'POST' }, res,
        { database: {}, tenantId, actor: { role }, parts },
      )
      assert.equal(handled, true)
      assert.equal(res.status, 403)
      assert.deepEqual(res.body, { error: 'restaurant_role_forbidden' })
    }
  }
})


const stockItemId = '123e4567-e89b-42d3-a456-426614174001'
const staffId = '123e4567-e89b-42d3-a456-426614174002'

function requestWithBody(method, body) {
  return {
    method,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
}

function stockDatabase({ quantity = '4.000', tracking = true } = {}) {
  const calls = []
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values })
      if (sql.includes('SELECT id,stock_tracking,stock_quantity')) {
        return { rows: [{ id: stockItemId, stock_tracking: tracking, stock_quantity: quantity }] }
      }
      if (sql.includes('UPDATE restaurant_menu_items SET stock_quantity')) {
        return { rows: [{ stock_quantity: String(Number(values[2]).toFixed(3)) }] }
      }
      if (sql.includes('SELECT id,quantity_delta,old_quantity,new_quantity,reason,created_at')) {
        return { rows: [{ id: 'event-1', quantity_delta: '2.5', old_quantity: '4', new_quantity: '6.5', reason: 'delivery received' }] }
      }
      return { rows: [] }
    },
    release() {},
  }
  return { calls, connect: async () => client }
}

test('owner stock adjustment updates quantity and writes an audit event', async () => {
  const database = stockDatabase()
  const res = response()
  const handled = await handleOwnerMenuRoutes(
    requestWithBody('POST', { quantity_delta: 2.5, reason: 'delivery received' }), res,
    { database, tenantId, actor: { role: 'owner', staffId }, parts: ['restaurant','demo','menu','items',stockItemId,'stock-adjustments'] },
  )
  assert.equal(handled, true)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.stock, { old_quantity: 4, new_quantity: '6.500' })
  const event = database.calls.find(call => call.sql.includes('INSERT INTO restaurant_stock_events'))
  assert.ok(event)
  assert.equal(event.values[5], 'delivery received')
  assert.equal(event.values[6], staffId)
})

test('stock adjustment cannot reduce quantity below zero', async () => {
  const database = stockDatabase({ quantity: '1.000' })
  const res = response()
  await handleOwnerMenuRoutes(
    requestWithBody('POST', { quantity_delta: -2, reason: 'damaged' }), res,
    { database, tenantId, actor: { role: 'owner', staffId }, parts: ['restaurant','demo','menu','items',stockItemId,'stock-adjustments'] },
  )
  assert.equal(res.status, 409)
  assert.deepEqual(res.body, { error: 'insufficient_stock' })
  assert.equal(database.calls.some(call => call.sql.includes('INSERT INTO restaurant_stock_events')), false)
})

test('stock adjustment rejects more than three decimal places', async () => {
  const database = stockDatabase()
  const res = response()
  await handleOwnerMenuRoutes(
    requestWithBody('POST', { quantity_delta: 0.0001, reason: 'correction' }), res,
    { database, tenantId, actor: { role: 'owner', staffId }, parts: ['restaurant','demo','menu','items',stockItemId,'stock-adjustments'] },
  )
  assert.equal(res.status, 400)
  assert.deepEqual(res.body, { error: 'invalid_stock_adjustment' })
  assert.equal(database.calls.length, 0)
})

test('stock adjustment requires stock tracking to be configured', async () => {
  const database = stockDatabase({ tracking: false })
  const res = response()
  await handleOwnerMenuRoutes(
    requestWithBody('POST', { quantity_delta: 1, reason: 'received' }), res,
    { database, tenantId, actor: { role: 'owner', staffId }, parts: ['restaurant','demo','menu','items',stockItemId,'stock-adjustments'] },
  )
  assert.equal(res.status, 409)
  assert.deepEqual(res.body, { error: 'stock_tracking_not_configured' })
})

test('stock adjustment history is tenant-scoped and returns recent events', async () => {
  const database = stockDatabase()
  const res = response()
  await handleOwnerMenuRoutes(
    { method: 'GET' }, res,
    { database, tenantId, actor: { role: 'owner', staffId }, parts: ['restaurant','demo','menu','items',stockItemId,'stock-adjustments'] },
  )
  assert.equal(res.status, 200)
  assert.equal(res.body.events.length, 1)
  assert.ok(database.calls.some(call => call.sql.includes('WHERE tenant_id=$1 AND item_id=$2')))
})

test('menu item patch rejects direct stock quantity edits so changes use the audit ledger', async () => {
  const res = response()
  const handled = await handleOwnerMenuRoutes(
    requestWithBody('PATCH', { stock_quantity: 99 }), res,
    { database: {}, tenantId, actor: { role: 'owner', staffId }, parts: ['restaurant','demo','menu','items',stockItemId] },
  )
  assert.equal(handled, true)
  assert.equal(res.status, 400)
  assert.deepEqual(res.body, { error: 'stock_adjustment_required' })
})

test('menu item patch rejects stock quantity even when another valid field is supplied', async () => {
  const calls = []
  const database = {
    async connect() {
      return {
        async query(sql, values = []) { calls.push({ sql, values }); return { rows: [] } },
        release() {},
      }
    },
  }
  const res = response()
  const handled = await handleOwnerMenuRoutes(
    requestWithBody('PATCH', { available: false, stock_quantity: 999 }), res,
    { database, tenantId, actor: { role: 'owner', staffId }, parts: ['restaurant','demo','menu','items',stockItemId] },
  )
  assert.equal(handled, true)
  assert.equal(res.status, 400)
  assert.deepEqual(res.body, { error: 'stock_adjustment_required' })
  assert.equal(calls.length, 0)
})


test('menu photo upload fails closed when private storage is not configured', async () => {
  const res = response()
  await handleOwnerMenuRoutes(
    requestWithBody('POST', { content_type: 'image/webp' }), res,
    { database: {}, tenantId, actor: { role: 'owner', staffId }, parts: ['restaurant','demo','menu','items',stockItemId,'photo-upload'] },
  )
  assert.equal(res.status, 503)
  assert.deepEqual(res.body, { error: 'object_storage_not_configured' })
})

test('menu photo upload rejects unsupported image types before database access', async () => {
  const res = response()
  await handleOwnerMenuRoutes(
    requestWithBody('POST', { content_type: 'image/svg+xml' }), res,
    { database: {}, tenantId, actor: { role: 'owner', staffId }, objectStorage: {
      endpoint: 'https://objects.example.test', bucket: 'private-media', region: 'ap-south-1',
      accessKeyId: 'ACCESSKEY12345678', secretAccessKey: 'a-secret-key-that-is-long-enough',
    }, parts: ['restaurant','demo','menu','items',stockItemId,'photo-upload'] },
  )
  assert.equal(res.status, 400)
  assert.deepEqual(res.body, { error: 'unsupported_image_type' })
})
