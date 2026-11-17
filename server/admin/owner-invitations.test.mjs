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
  if (request.headers.authorization !== 'Bearer admin-token') {
    const error = new Error('unauthorized'); error.statusCode = 401; throw error
  }
  return { issuer: 'https://issuer.example.test/', subject: 'platform-admin' }
}
const ownerAccess = async () => ({
  issuer: 'https://issuer.example.test/', subject: 'owner-subject',
})
const verifiedOwner = async () => ({
  issuer: 'https://issuer.example.test/', subject: 'owner-subject',
  email: 'owner@example.test', emailVerified: true,
})
const unverifiedOwner = async () => ({
  issuer: 'https://issuer.example.test/', subject: 'owner-subject',
  email: 'owner@example.test', emailVerified: false,
})
const future = new Date(Date.now() + 60_000).toISOString()

test('owner invitation creation is Super Admin only', async () => {
  await withServer({ database: { query: async () => ({ rows: [] }) }, authenticateAdmin: admin }, async base => {
    const response = await fetch(base + '/admin/owner-invitations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.test' }),
    })
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'unauthorized' })
  })
})

test('creates a one-time invitation and returns only the plaintext token once', async () => {
  let args
  await withServer({
    authenticateAdmin: admin,
    database: { connect: async () => ({
      query: async (sql, values = []) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || /set_config/.test(sql)) return { rows: [] }
        if (/SELECT id FROM tenants/.test(sql)) return { rows: [{ id: values[0] }] }
        if (/SELECT 1 FROM tenant_memberships/.test(sql)) return { rows: [] }
        if (/UPDATE platform_owner_invitations SET status='expired'/.test(sql)) return { rows: [] }
        if (/INSERT INTO platform_owner_invitations/.test(sql)) {
          args = values
          return { rows: [{ id: 'invite-1', tenant_id: values[0], email: values[1], expires_at: future }] }
        }
        if (/INSERT INTO platform_audit_events/.test(sql)) return { rows: [] }
        throw new Error('unexpected SQL')
      },
      release: () => {},
    }) },
  }, async base => {
    const response = await fetch(base + '/admin/owner-invitations', {
      method: 'POST', headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: '11111111-1111-4111-8111-111111111111', email: ' OWNER@Example.Test ' }),
    })
    assert.equal(response.status, 201)
    const body = await response.json()
    assert.equal(body.invitation.email, 'owner@example.test')
    assert.match(body.token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(body.delivery, 'manual_link_required')
    assert.notEqual(args[2], body.token)
    assert.match(args[2], /^[0-9a-f]{64}$/)
  })
})

test('owner acceptance requires a verified email claim', async () => {
  let databaseTouched = false
  await withServer({
    authenticateIdentity: ownerAccess,
    authenticateVerifiedEmail: unverifiedOwner,
    database: { connect: async () => { databaseTouched = true } },
  }, async base => {
    const response = await fetch(base + '/owner/invitations/accept', {
      method: 'POST', headers: { Authorization: 'Bearer owner-access-token', 'Content-Type': 'application/json', 'X-OIDC-ID-Token': 'signed-id-token' }, body: JSON.stringify({ token: 'a'.repeat(43) }),
    })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'verified_email_required' })
    assert.equal(databaseTouched, false)
  })
})

test('acceptance binds verified email, creates membership and writes platform audit in one transaction', async () => {
  const statements = []
  const client = {
    query: async (sql, args = []) => {
      statements.push({ sql, args })
      if (/SELECT i\.id,i\.tenant_id/.test(sql)) return { rows: [{
        id: 'invite-1', tenant_id: 'tenant-1', email: 'owner@example.test',
        status: 'pending', expires_at: future, tenant_name: 'Cafe', tenant_status: 'active',
      }] }
      if (/SELECT user_id FROM tenant_memberships/.test(sql)) return { rows: [] }
      if (/INSERT INTO platform_users/.test(sql)) return { rows: [{ id: 'user-1' }] }
      return { rows: [] }
    },
    release: () => statements.push({ sql: 'RELEASE' }),
  }
  await withServer({
    authenticateIdentity: ownerAccess,
    authenticateVerifiedEmail: verifiedOwner,
    database: { connect: async () => client },
  }, async base => {
    const response = await fetch(base + '/owner/invitations/accept', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner-access-token', 'X-OIDC-ID-Token': 'signed-id-token' },
      body: JSON.stringify({ token: 'a'.repeat(43) }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { accepted: true, tenant: { id: 'tenant-1', name: 'Cafe' } })
  })
  assert.equal(statements[0].sql, 'BEGIN')
  assert.ok(statements.some(item => /INSERT INTO tenant_memberships/.test(item.sql)))
  assert.ok(statements.some(item => /owner\.invitation\.accepted/.test(item.sql)))
  assert.ok(statements.some(item => item.sql === 'COMMIT'))
  assert.equal(statements.some(item => item.sql === 'ROLLBACK'), false)
  assert.equal(statements.at(-1).sql, 'RELEASE')
})

test('acceptance rejects an email mismatch and rolls back', async () => {
  const statements = []
  const client = {
    query: async sql => {
      statements.push(sql)
      if (/SELECT i\.id,i\.tenant_id/.test(sql)) return { rows: [{
        id: 'invite-1', tenant_id: 'tenant-1', email: 'different@example.test',
        status: 'pending', expires_at: future, tenant_name: 'Cafe', tenant_status: 'active',
      }] }
      return { rows: [] }
    },
    release: () => {},
  }
  await withServer({
    authenticateIdentity: ownerAccess,
    authenticateVerifiedEmail: verifiedOwner,
    database: { connect: async () => client },
  }, async base => {
    const response = await fetch(base + '/owner/invitations/accept', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner-access-token', 'X-OIDC-ID-Token': 'signed-id-token' },
      body: JSON.stringify({ token: 'a'.repeat(43) }),
    })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'invitation_email_mismatch' })
  })
  assert.ok(statements.includes('ROLLBACK'))
  assert.equal(statements.includes('COMMIT'), false)
})


test('Super Admin can list invitations without exposing token hashes', async () => {
  let sqlSeen = ''
  await withServer({
    authenticateAdmin: admin,
    database: { query: async sql => {
      sqlSeen = sql
      return { rows: [{ id:'invite-1', tenant_id:'tenant-1', tenant_name:'Cafe', tenant_slug:'cafe', email:'owner@example.test', status:'pending', created_at:future, expires_at:future }] }
    } },
  }, async base => {
    const response = await fetch(base + '/admin/owner-invitations', { headers: { Authorization:'Bearer admin-token' } })
    assert.equal(response.status,200)
    const body = await response.json()
    assert.equal(body.invitations[0].email,'owner@example.test')
    assert.equal(JSON.stringify(body).includes('token_hash'),false)
    assert.match(sqlSeen,/LIMIT 500/)
  })
})

test('Super Admin revokes a pending invitation transactionally and audits it', async () => {
  const statements=[]
  const client={query:async(sql,args=[])=>{
    statements.push({sql,args})
    if(/SELECT id,status,tenant_id,email FROM platform_owner_invitations/.test(sql))
      return {rows:[{id:'11111111-1111-4111-8111-111111111111',status:'pending',tenant_id:'tenant-1',email:'owner@example.test'}]}
    if(/UPDATE platform_owner_invitations SET status='revoked'/.test(sql)) return {rows:[{id:args[0]}]}
    return {rows:[]}
  },release:()=>{}}
  await withServer({authenticateAdmin:admin,database:{connect:async()=>client}},async base=>{
    const response=await fetch(base+'/admin/owner-invitations/11111111-1111-4111-8111-111111111111/revoke',{
      method:'POST',headers:{Authorization:'Bearer admin-token'}
    })
    assert.equal(response.status,200)
    assert.deepEqual(await response.json(),{revoked:true,id:'11111111-1111-4111-8111-111111111111'})
  })
  assert.equal(statements[0].sql,'BEGIN')
  assert.ok(statements.some(x=>x.sql.includes('owner.invitation.revoked')))
  assert.ok(statements.some(x=>x.sql==='COMMIT'))
  assert.equal(statements.some(x=>x.sql==='ROLLBACK'),false)
})

test('owner invitation acceptance rejects an ID token for a different subject', async () => {
  let databaseTouched = false
  await withServer({
    authenticateIdentity: ownerAccess,
    authenticateVerifiedEmail: async () => ({
      issuer: 'https://issuer.example.test/', subject: 'different-subject',
      email: 'owner@example.test', emailVerified: true,
    }),
    database: { connect: async () => { databaseTouched = true } },
  }, async base => {
    const response = await fetch(base + '/owner/invitations/accept', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-access-token',
        'X-OIDC-ID-Token': 'signed-id-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: 'a'.repeat(43) }),
    })
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'identity_token_subject_mismatch' })
    assert.equal(databaseTouched, false)
  })
})

test('owner invitation acceptance requires the separate ID token', async () => {
  await withServer({
    authenticateIdentity: ownerAccess,
    authenticateVerifiedEmail: verifiedOwner,
    database: { connect: async () => { throw new Error('database must not be touched') } },
  }, async base => {
    const response = await fetch(base + '/owner/invitations/accept', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-access-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(43) }),
    })
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'id_token_required' })
  })
})
