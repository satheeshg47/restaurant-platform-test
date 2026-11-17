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

test('audit event list requires owner authentication', async () => {
  await withServer({ database: { query: async () => ({ rows: [] }) }, authenticateAdmin: ownerAuth }, async base => {
    const response = await fetch(`${base}/admin/audit-events`)
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'unauthorized' })
  })
})

test('lists audit events with bounded pagination and no-store response', async () => {
  const event = {
    id: 'event-1',
    actor_issuer: 'https://identity.example.test/',
    actor_subject: 'configured-owner',
    action: 'application.created',
    resource_type: 'application',
    resource_id: 'app-1',
    metadata: { app_key: 'restaurant' },
    created_at: '2026-11-17T00:00:00.000Z',
    total_count: 31,
  }
  let args
  await withServer({
    database: { query: async (...values) => { args = values; return { rows: [event] } } },
    authenticateAdmin: ownerAuth,
  }, async base => {
    const response = await fetch(`${base}/admin/audit-events?limit=10&offset=20`, {
      headers: { Authorization: 'Bearer owner-token' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), {
      events: [{ id: event.id, actor_issuer: event.actor_issuer, actor_subject: event.actor_subject, action: event.action, resource_type: event.resource_type, resource_id: event.resource_id, metadata: event.metadata, created_at: event.created_at }],
      pagination: { limit: 10, offset: 20, total: 31, has_more: true },
    })
    assert.match(args[0], /FROM platform_audit_events/)
    assert.match(args[0], /ORDER BY created_at DESC, id DESC/)
    assert.deepEqual(args[1], [10, 20])
  })
})

test('rejects unsafe pagination before querying database', async () => {
  let called = false
  await withServer({
    database: { query: async () => { called = true; return { rows: [] } } },
    authenticateAdmin: ownerAuth,
  }, async base => {
    const response = await fetch(`${base}/admin/audit-events?limit=1000&offset=-1`, {
      headers: { Authorization: 'Bearer owner-token' },
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_pagination' })
    assert.equal(called, false)
  })
})

test('returns forbidden for a valid identity that is not the owner', async () => {
  await withServer({
    database: { query: async () => ({ rows: [] }) },
    authenticateAdmin: async () => { const error = new Error('not owner'); error.statusCode = 403; throw error },
  }, async base => {
    const response = await fetch(`${base}/admin/audit-events`, {
      headers: { Authorization: 'Bearer another-user-token' },
    })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'forbidden' })
  })
})

test('fails closed when database is not configured', async () => {
  await withServer({ authenticateAdmin: ownerAuth }, async base => {
    const response = await fetch(`${base}/admin/audit-events`, {
      headers: { Authorization: 'Bearer owner-token' },
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'database_not_configured' })
  })
})

test('does not leak database errors', async () => {
  await withServer({
    database: { query: async () => { throw new Error('sensitive database detail') } },
    authenticateAdmin: ownerAuth,
  }, async base => {
    const response = await fetch(`${base}/admin/audit-events`, {
      headers: { Authorization: 'Bearer owner-token' },
    })
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'audit_events_list_failed' })
  })
})
