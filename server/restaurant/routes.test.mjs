import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiServer } from '../app.mjs'

const tenantId = '123e4567-e89b-42d3-a456-426614174000'

async function startServer(t, options = {}) {
  const server = createApiServer({ environment: 'test', objectStorage: options.objectStorage }, options)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

test('restaurant route returns 503 when database is not configured', async t => {
  const base = await startServer(t)
  const response = await fetch(`${base}/restaurant/demo/tables`)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'database_not_configured' })
})

test('restaurant route does not disclose whether an unknown tenant exists', async t => {
  const database = { query: async () => ({ rows: [] }) }
  const base = await startServer(t, { database })
  const response = await fetch(`${base}/restaurant/not-a-tenant/tables`)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'restaurant_not_found' })
})

test('staff routes require configured identity authentication', async t => {
  const database = { query: async () => ({ rows: [{ id: tenantId }] }) }
  const base = await startServer(t, { database })
  const response = await fetch(`${base}/restaurant/demo/tables`)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'identity_auth_not_configured' })
})

test('QR guest route rejects malformed tokens without attempting a database transaction', async t => {
  let connected = false
  const database = {
    query: async () => ({ rows: [{ id: tenantId }] }),
    connect: async () => { connected = true; throw new Error('unexpected transaction') },
  }
  const base = await startServer(t, { database })
  const response = await fetch(`${base}/restaurant/demo/guest/not-a-token/menu`)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'qr_not_found' })
  assert.equal(connected, false)
})

test('restaurant routes do not intercept unrelated API paths', async t => {
  const base = await startServer(t)
  const response = await fetch(`${base}/not-restaurant`)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not_found' })
})


test('QR guest menu returns short-lived signed URLs for private menu photos', async t => {
  const token = 'A'.repeat(43)
  const itemId = '223e4567-e89b-42d3-a456-426614174001'
  const tableId = '323e4567-e89b-42d3-a456-426614174002'
  const objectKey = `restaurants/${tenantId}/menu/${itemId}.webp`
  const database = {
    query: async () => ({ rows: [{ id: tenantId }] }),
    connect: async () => ({
      query: async sql => {
        const statement = String(sql)
        if (statement.includes('SELECT id, label, table_type FROM restaurant_tables')) return { rows: [{ id: tableId, label: 'Table 1', table_type: 'dine_in' }] }
        if (statement.includes('SELECT display_name, currency_code')) return { rows: [{ display_name: 'Demo', currency_code: 'INR' }] }
        if (statement.includes('SELECT id, name, sort_order, station FROM restaurant_menu_categories')) return { rows: [{ id: '423e4567-e89b-42d3-a456-426614174003', name: { en: 'Food' }, sort_order: 1 }] }
        if (statement.includes('SELECT id, category_id, name, description, base_price_minor')) return { rows: [{ id: itemId, category_id: '423e4567-e89b-42d3-a456-426614174003', name: { en: 'Dosa' }, photo_object_key: objectKey }] }
        if (statement.includes('SELECT v.id, v.item_id')) return { rows: [] }
        if (statement.includes('SELECT g.id, g.name')) return { rows: [] }
        if (statement.includes('SELECT id, status FROM restaurant_table_sessions')) return { rows: [{ id: '523e4567-e89b-42d3-a456-426614174004', status: 'open' }] }
        return { rows: [] }
      },
      release() {},
    }),
  }
  const objectStorage = {
    endpoint: 'https://objects.example.test',
    bucket: 'restaurant-private',
    region: 'ap-south-1',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
  }
  const base = await startServer(t, { database, objectStorage })
  const response = await fetch(`${base}/restaurant/demo/guest/${token}/menu`)
  assert.equal(response.status, 200)
  const body = await response.json()
  const photoUrl = body.categories[0].items[0].photo_url
  assert.equal(typeof photoUrl, 'string')
  const signed = new URL(photoUrl)
  assert.equal(signed.protocol, 'https:')
  assert.match(signed.pathname, new RegExp(itemId.replaceAll('-', '\\-')))
  assert.equal(signed.searchParams.get('X-Amz-Expires'), '300')
  assert.ok(signed.searchParams.get('X-Amz-Signature'))
})

test('QR guest menu returns null photo URL when private storage is not configured', async t => {
  const token = 'B'.repeat(43)
  const database = {
    query: async () => ({ rows: [{ id: tenantId }] }),
    connect: async () => ({
      query: async sql => {
        const statement = String(sql)
        if (statement.includes('SELECT id, label, table_type FROM restaurant_tables')) return { rows: [{ id: '323e4567-e89b-42d3-a456-426614174002', label: 'Table 1', table_type: 'dine_in' }] }
        if (statement.includes('SELECT display_name, currency_code')) return { rows: [{ display_name: 'Demo', currency_code: 'INR' }] }
        if (statement.includes('SELECT id, name, sort_order, station FROM restaurant_menu_categories')) return { rows: [{ id: '423e4567-e89b-42d3-a456-426614174003', name: { en: 'Food' }, sort_order: 1 }] }
        if (statement.includes('SELECT id, category_id, name, description, base_price_minor')) return { rows: [{ id: '223e4567-e89b-42d3-a456-426614174001', category_id: '423e4567-e89b-42d3-a456-426614174003', name: { en: 'Dosa' }, photo_object_key: 'restaurants/private/menu/photo.webp' }] }
        if (statement.includes('SELECT v.id, v.item_id') || statement.includes('SELECT g.id, g.name')) return { rows: [] }
        if (statement.includes('SELECT id, status FROM restaurant_table_sessions')) return { rows: [] }
        return { rows: [] }
      },
      release() {},
    }),
  }
  const base = await startServer(t, { database })
  const response = await fetch(`${base}/restaurant/demo/guest/${token}/menu`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.categories[0].items[0].photo_url, null)
})
