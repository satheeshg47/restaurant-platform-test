import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiServer } from '../app.mjs'

async function withServer(options, run) {
  const server = createApiServer({ environment: 'test', adminAuthConfigured: true }, options)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

const ownerAuth = async request => {
  if (request.headers.authorization !== 'Bearer owner-token') {
    const error = new Error('unauthorized')
    error.statusCode = 401
    throw error
  }
  return { issuer: 'https://identity.example.test/', subject: 'configured-owner' }
}

test('application registry requires owner authentication', async () => {
  await withServer({ database: { query: async () => ({ rows: [] }) }, authenticateAdmin: ownerAuth }, async base => {
    const response = await fetch(`${base}/admin/applications`)
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'unauthorized' })
  })
})

test('lists applications only after owner authentication', async () => {
  const rows = [{ id: 'app-1', app_key: 'restaurant', name: 'Restaurant', status: 'active' }]
  const queries = []
  await withServer({
    database: { query: async (...args) => { queries.push(args); return { rows } } },
    authenticateAdmin: ownerAuth,
  }, async base => {
    const response = await fetch(`${base}/admin/applications`, { headers: { Authorization: 'Bearer owner-token' } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { applications: rows })
    assert.match(queries[0][0], /FROM applications/)
  })
})

test('creates an application and its audit event atomically using parameterized SQL', async () => {
  const created = { id: 'app-2', app_key: 'inventory', name: 'Inventory', status: 'draft' }
  let queryArgs
  await withServer({
    database: { query: async (...args) => { queryArgs = args; return { rows: [created] } } },
    authenticateAdmin: ownerAuth,
  }, async base => {
    const response = await fetch(`${base}/admin/applications`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_key: 'inventory', name: ' Inventory ' }),
    })
    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), { application: created })
    assert.match(queryArgs[0], /INSERT INTO applications/)
    assert.match(queryArgs[0], /INSERT INTO platform_audit_events/)
    assert.match(queryArgs[0], /CROSS JOIN audited/)
    assert.deepEqual(queryArgs[1], ['inventory', 'Inventory', 'https://identity.example.test/', 'configured-owner'])
  })
})

test('does not create an application if the audit insert fails', async () => {
  await withServer({
    database: { query: async () => { const error = new Error('audit storage unavailable'); error.code = '08006'; throw error } },
    authenticateAdmin: ownerAuth,
  }, async base => {
    const response = await fetch(`${base}/admin/applications`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_key: 'inventory', name: 'Inventory' }),
    })
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'application_create_failed' })
  })
})

test('rejects invalid application input before database writes', async () => {
  let called = false
  await withServer({
    database: { query: async () => { called = true; return { rows: [] } } },
    authenticateAdmin: ownerAuth,
  }, async base => {
    const response = await fetch(`${base}/admin/applications`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_key: 'Bad Key', name: '' }),
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_application' })
    assert.equal(called, false)
  })
})

test('reports duplicate application keys without leaking database details', async () => {
  await withServer({
    database: { query: async () => { const error = new Error('constraint detail'); error.code = '23505'; throw error } },
    authenticateAdmin: ownerAuth,
  }, async base => {
    const response = await fetch(`${base}/admin/applications`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_key: 'restaurant', name: 'Restaurant' }),
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'application_key_exists' })
  })
})

test('does not expose application data when database is unavailable', async () => {
  await withServer({ authenticateAdmin: ownerAuth }, async base => {
    const response = await fetch(`${base}/admin/applications`, {
      headers: { Authorization: 'Bearer owner-token' },
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'database_not_configured' })
  })
})

test('returns forbidden for a valid identity that is not the configured owner', async () => {
  await withServer({
    database: { query: async () => ({ rows: [] }) },
    authenticateAdmin: async () => { const error = new Error('not owner'); error.statusCode = 403; throw error },
  }, async base => {
    const response = await fetch(`${base}/admin/applications`, {
      headers: { Authorization: 'Bearer another-user-token' },
    })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'forbidden' })
  })
})
