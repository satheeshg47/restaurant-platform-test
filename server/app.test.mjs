import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiServer } from './app.mjs'

test('health endpoint reports process health without claiming database readiness', async (t) => {
  const server = createApiServer({ environment: 'test' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))

  const address = server.address()
  const response = await fetch(`http://127.0.0.1:${address.port}/health`)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.status, 'ok')
  assert.equal(body.checks.database, 'not_configured')
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('unknown routes return JSON 404', async (t) => {
  const server = createApiServer({ environment: 'test' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))

  const address = server.address()
  const response = await fetch(`http://127.0.0.1:${address.port}/missing`)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not_found' })
})


test('readiness returns 503 when database is not configured', async (t) => {
  const server = createApiServer({ environment: 'test' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))

  const response = await fetch(`http://127.0.0.1:${server.address().port}/ready`)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    status: 'not_ready',
    checks: { database: 'not_configured' },
  })
})

test('readiness returns 200 only after a successful database probe', async (t) => {
  const queries = []
  const database = {
    query: async sql => { queries.push(sql); return { rows: [{ '?column?': 1 }] } },
  }
  const server = createApiServer({ environment: 'test' }, { database, logger: { error() {} } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))

  const response = await fetch(`http://127.0.0.1:${server.address().port}/ready`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    status: 'ready',
    checks: { database: 'ok' },
  })
  assert.deepEqual(queries, ['SELECT 1'])
})

test('readiness hides database errors and returns 503 when the probe fails', async (t) => {
  const database = {
    query: async () => { throw new Error('secret connection details must not leak') },
  }
  const server = createApiServer({ environment: 'test' }, { database })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))

  const response = await fetch(`http://127.0.0.1:${server.address().port}/ready`)
  assert.equal(response.status, 503)
  const body = await response.json()
  assert.deepEqual(body, {
    status: 'not_ready',
    checks: { database: 'unavailable' },
  })
  assert.equal(JSON.stringify(body).includes('secret'), false)
})


test('liveness stays healthy while the configured database is unavailable', async (t) => {
  const database = { query: async () => { throw new Error('database offline') } }
  const server = createApiServer({ environment: 'test' }, { database, logger: { error() {} } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))

  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.checks.process, 'ok')
  assert.equal(body.checks.database, 'configured')
})


test('admin session is unavailable until OIDC is configured', async (t) => {
  const server = createApiServer({ environment: 'test', adminAuthConfigured: false })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/session`)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'admin_auth_not_configured' })
})

test('admin session returns verified owner identity', async (t) => {
  const server = createApiServer(
    { environment: 'test', adminAuthConfigured: true },
    { authenticateAdmin: async request => {
      assert.equal(request.headers.authorization, 'Bearer valid-token')
      return { issuer: 'https://identity.example.test/', subject: 'owner-subject' }
    } },
  )
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/session`, {
    headers: { Authorization: 'Bearer valid-token' },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    authenticated: true,
    admin: { issuer: 'https://identity.example.test/', subject: 'owner-subject' },
  })
})

test('admin session does not leak authentication errors', async (t) => {
  const server = createApiServer(
    { environment: 'test', adminAuthConfigured: true },
    { authenticateAdmin: async () => { throw new Error('sensitive token validation details') } },
  )
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/session`)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'unauthorized' })
})
