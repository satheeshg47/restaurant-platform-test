import test from 'node:test'
import assert from 'node:assert/strict'
import { isPlatformAdmin, requirePlatformAdmin } from './admin-authorization.mjs'

const config = {
  adminIssuer: 'https://identity.example.test/',
  adminSubject: 'stable-identity-subject-123',
}

test('allows only the configured issuer and stable subject pair', () => {
  assert.equal(isPlatformAdmin({
    iss: config.adminIssuer,
    sub: config.adminSubject,
    email: 'someone@example.test',
  }, config), true)
})

test('does not grant admin access based on email alone', () => {
  assert.equal(isPlatformAdmin({
    iss: config.adminIssuer,
    sub: 'different-subject',
    email: 'owner@example.test',
  }, config), false)
})

test('rejects missing identity configuration', () => {
  assert.equal(isPlatformAdmin({ iss: config.adminIssuer, sub: config.adminSubject }, {}), false)
})

test('throws a 403 for non-admin identities', () => {
  assert.throws(
    () => requirePlatformAdmin({ iss: config.adminIssuer, sub: 'not-the-owner' }, config),
    error => error.statusCode === 403,
  )
})


test('verifies bearer tokens against configured OIDC issuer and audience', async () => {
  const { createAdminTokenVerifier } = await import('./admin-authorization.mjs')
  const calls = []
  const verifier = createAdminTokenVerifier({
    adminAuthConfigured: true,
    oidcJwksUrl: 'https://identity.example.test/jwks',
    oidcIssuer: config.adminIssuer,
    oidcAudience: 'platform-core',
    adminIssuer: config.adminIssuer,
    adminSubject: config.adminSubject,
  }, {
    jwks: {},
    verify: async (token, keySet, options) => {
      calls.push({ token, keySet, options })
      return { payload: { iss: config.adminIssuer, sub: config.adminSubject } }
    },
  })
  const identity = await verifier({ headers: { authorization: 'Bearer signed.jwt.token' } })
  assert.deepEqual(identity, { issuer: config.adminIssuer, subject: config.adminSubject })
  assert.equal(calls[0].token, 'signed.jwt.token')
  assert.equal(calls[0].options.audience, 'platform-core')
  assert.deepEqual(calls[0].options.algorithms, ['RS256', 'ES256'])
})

test('rejects missing bearer token without calling token verifier', async () => {
  const { createAdminTokenVerifier } = await import('./admin-authorization.mjs')
  let called = false
  const verifier = createAdminTokenVerifier({
    adminAuthConfigured: true,
    oidcJwksUrl: 'https://identity.example.test/jwks',
    oidcIssuer: config.adminIssuer,
    oidcAudience: 'platform-core',
    adminIssuer: config.adminIssuer,
    adminSubject: config.adminSubject,
  }, { jwks: {}, verify: async () => { called = true; throw new Error('should not run') } })
  await assert.rejects(verifier({ headers: {} }), error => error.statusCode === 401)
  assert.equal(called, false)
})

test('does not initialize OIDC verifier with incomplete configuration', async () => {
  const { createAdminTokenVerifier } = await import('./admin-authorization.mjs')
  assert.throws(() => createAdminTokenVerifier({ adminAuthConfigured: false }), /not configured/)
})

test('returns 403 when a valid signed token belongs to a different subject', async () => {
  const { createAdminTokenVerifier } = await import('./admin-authorization.mjs')
  const verifier = createAdminTokenVerifier({
    adminAuthConfigured: true,
    oidcJwksUrl: 'https://identity.example.test/jwks',
    oidcIssuer: config.adminIssuer,
    oidcAudience: 'platform-core',
    adminIssuer: config.adminIssuer,
    adminSubject: config.adminSubject,
  }, {
    jwks: {},
    verify: async () => ({ payload: { iss: config.adminIssuer, sub: 'different-subject' } }),
  })
  await assert.rejects(
    verifier({ headers: { authorization: 'Bearer valid.signed.token' } }),
    error => error.statusCode === 403,
  )
})
