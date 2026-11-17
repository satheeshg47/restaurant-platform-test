import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiServer } from '../app.mjs'

async function withServer(options, run) {
  const server = createApiServer({ environment: 'test', adminAuthConfigured: true }, options)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { await new Promise(resolve => server.close(resolve)) }
}

const admin = async request => {
  if (request.headers.authorization !== 'Bearer admin') { const e = new Error('unauthorized'); e.statusCode = 401; throw e }
  return { issuer: 'https://id.example/', subject: 'platform-owner' }
}
const identity = async request => {
  if (request.headers.authorization !== 'Bearer owner') { const e = new Error('unauthorized'); e.statusCode = 401; throw e }
  return { issuer: 'https://id.example/', subject: 'restaurant-owner' }
}

test('admin communication inbox requires platform administrator authentication', async () => {
  await withServer({ authenticateAdmin: admin, database: { query: async () => ({ rows: [] }) } }, async base => {
    const response = await fetch(base + '/admin/communications')
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'unauthorized' })
  })
})

test('admin inbox returns database conversations and unread counts', async () => {
  const rows = [{ id: 'c1', kind: 'support', subject: 'Bug', status: 'open', unread_count: 2 }]
  await withServer({ authenticateAdmin: admin, database: { query: async sql => {
    assert.match(sql, /communication_conversations/)
    assert.match(sql, /unread_count/)
    return { rows }
  } } }, async base => {
    const response = await fetch(base + '/admin/communications', { headers: { Authorization: 'Bearer admin' } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { conversations: rows })
  })
})

test('owner communication is denied unless identity has an active owner membership', async () => {
  await withServer({
    authenticateIdentity: identity,
    database: { query: async sql => {
      assert.match(sql, /tenant_memberships/)
      return { rows: [] }
    } },
  }, async base => {
    const response = await fetch(base + '/owner/communications', { headers: { Authorization: 'Bearer owner' } })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'active_owner_required' })
  })
})

test('owner can create a private support conversation after owner membership verification', async () => {
  const queries = []
  const database = { query: async (sql, args) => {
    queries.push({ sql, args })
    if (sql.includes('FROM platform_users pu')) return { rows: [{ user_id: 'user-1', tenant_id: 'tenant-1' }] }
    return { rows: [{ id: 'message-1', conversation_id: 'conversation-1', body: 'Please fix checkout', created_at: '2026-11-17T00:00:00Z' }] }
  } }
  await withServer({ authenticateIdentity: identity, database }, async base => {
    const response = await fetch(base + '/owner/communications', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Checkout bug', message: 'Please fix checkout' }),
    })
    assert.equal(response.status, 201)
    assert.equal((await response.json()).message.conversation_id, 'conversation-1')
    assert.equal(queries.length, 2)
    assert.deepEqual(queries[1].args, ['Checkout bug', 'restaurant-owner', 'user-1', 'tenant-1', 'Please fix checkout'])
  })
})

test('owner cannot open another owner conversation', async () => {
  let call = 0
  const database = { query: async () => {
    call += 1
    if (call === 1) return { rows: [{ user_id: 'user-1', tenant_id: 'tenant-1' }] }
    return { rows: [] }
  } }
  await withServer({ authenticateIdentity: identity, database }, async base => {
    const response = await fetch(base + '/owner/communications/other-owner-thread', {
      headers: { Authorization: 'Bearer owner' },
    })
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'conversation_not_found' })
  })
})

test('rejects oversized communication bodies', async () => {
  const database = { query: async () => ({ rows: [{ user_id: 'user-1', tenant_id: 'tenant-1' }] }) }
  await withServer({ authenticateIdentity: identity, database }, async base => {
    const response = await fetch(base + '/owner/communications', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Large', message: 'x'.repeat(17000) }),
    })
    assert.equal(response.status, 413)
    assert.deepEqual(await response.json(), { error: 'payload_too_large' })
  })
})


test('owner conversation endpoint rejects JSON null safely', async () => {
  const database = { query: async () => ({ rows: [{ user_id: 'user-1', tenant_id: 'tenant-1' }] }) }
  await withServer({ authenticateIdentity: identity, database }, async base => {
    const response = await fetch(base + '/owner/communications', {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: 'null',
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_conversation' })
  })
})

test('admin group endpoint rejects JSON null safely', async () => {
  await withServer({ authenticateAdmin: admin, database: { query: async () => ({ rows: [] }) } }, async base => {
    const response = await fetch(base + '/admin/communications', {
      method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: 'null',
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_group_or_announcement' })
  })
})


test('owner reply endpoint rejects JSON null safely', async () => {
  const database = { query: async () => ({ rows: [{ user_id: 'user-1', tenant_id: 'tenant-1' }] }) }
  await withServer({ authenticateIdentity: identity, database }, async base => {
    const response = await fetch(base + '/owner/communications/00000000-0000-4000-8000-000000000001/messages', {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: 'null',
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_message' })
  })
})


test('owner can list every active tenant membership for the tenant switcher', async () => {
  const tenants = [
    { tenant_id: '11111111-1111-4111-8111-111111111111', tenant_name: 'Cafe One', tenant_slug: 'cafe-one' },
    { tenant_id: '22222222-2222-4222-8222-222222222222', tenant_name: 'Cafe Two', tenant_slug: 'cafe-two' },
  ]
  await withServer({
    authenticateIdentity: identity,
    database: { query: async sql => {
      assert.match(sql, /JOIN tenants t/)
      assert.match(sql, /tm\.role = 'owner'/)
      return { rows: tenants }
    } },
  }, async base => {
    const response = await fetch(base + '/owner/communications/tenants', { headers: { Authorization: 'Bearer owner' } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { tenants })
  })
})

test('owner must select a tenant when the identity owns multiple tenants', async () => {
  await withServer({
    authenticateIdentity: identity,
    database: { query: async () => ({ rows: [
      { user_id: 'user-1', tenant_id: 'tenant-1' },
      { user_id: 'user-1', tenant_id: 'tenant-2' },
    ] }) },
  }, async base => {
    const response = await fetch(base + '/owner/communications', { headers: { Authorization: 'Bearer owner' } })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'tenant_selection_required' })
  })
})

test('owner conversation list is scoped to the selected active tenant', async () => {
  const tenantId = '11111111-1111-4111-8111-111111111111'
  const calls = []
  await withServer({
    authenticateIdentity: identity,
    database: { query: async (sql, args) => {
      calls.push({ sql, args })
      if (sql.includes('FROM platform_users pu')) {
        assert.equal(args[2], tenantId)
        return { rows: [{ user_id: 'user-1', tenant_id: tenantId }] }
      }
      return { rows: [] }
    } },
  }, async base => {
    const response = await fetch(base + '/owner/communications?tenant_id=' + tenantId, { headers: { Authorization: 'Bearer owner' } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { conversations: [] })
  })
  assert.deepEqual(calls[1].args, ['user-1', tenantId])
  assert.match(calls[1].sql, /p\.tenant_id=\$2/)
})

test('owner cannot read a conversation from a different selected tenant', async () => {
  const tenantId = '11111111-1111-4111-8111-111111111111'
  let call = 0
  await withServer({
    authenticateIdentity: identity,
    database: { query: async (sql, args) => {
      call += 1
      if (call === 1) return { rows: [{ user_id: 'user-1', tenant_id: tenantId }] }
      assert.match(sql, /p\.tenant_id=\$3/)
      assert.deepEqual(args, ['conversation-1', 'user-1', tenantId])
      return { rows: [] }
    } },
  }, async base => {
    const response = await fetch(base + '/owner/communications/conversation-1?tenant_id=' + tenantId, { headers: { Authorization: 'Bearer owner' } })
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'conversation_not_found' })
  })
})

test('owner communications rejects malformed tenant selectors', async () => {
  let databaseTouched = false
  await withServer({
    authenticateIdentity: identity,
    database: { query: async () => { databaseTouched = true; return { rows: [] } } },
  }, async base => {
    const response = await fetch(base + '/owner/communications?tenant_id=not-a-uuid', { headers: { Authorization: 'Bearer owner' } })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_tenant_id' })
    assert.equal(databaseTouched, false)
  })
})


test('admin owner directory lists all active tenant names per owner', async () => {
  const owners = [{ user_id: 'owner-1', email: 'owner@example.com', tenant_names: ['Cafe One', 'Cafe Two'] }]
  await withServer({
    authenticateAdmin: admin,
    database: { query: async sql => {
      assert.match(sql, /array_agg\(DISTINCT t\.name ORDER BY t\.name\)/)
      assert.match(sql, /GROUP BY pu\.id, pu\.email/)
      assert.match(sql, /t\.status = 'active'/)
      return { rows: owners }
    } },
  }, async base => {
    const response = await fetch(base + '/admin/communications/owners', { headers: { Authorization: 'Bearer admin' } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { owners })
  })
})
