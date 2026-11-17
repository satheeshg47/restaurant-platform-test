import test from 'node:test'
import assert from 'node:assert/strict'
import { createOidcIdentityVerifier } from './identity-authorization.mjs'

const config = {
  oidcIssuer: 'https://identity.example.test/',
  oidcAudience: 'platform-core',
  oidcJwksUrl: 'https://identity.example.test/jwks',
}

function verifierFor(payload) {
  return createOidcIdentityVerifier(config, {
    jwks: {},
    verify: async (_token, _keySet, options) => {
      assert.equal(options.issuer, config.oidcIssuer)
      assert.equal(options.audience, config.oidcAudience)
      assert.deepEqual(options.algorithms, ['RS256', 'ES256'])
      return { payload }
    },
  })
}

test('returns stable identity and a verified email claim', async () => {
  const authenticate = verifierFor({
    iss: config.oidcIssuer,
    sub: 'subject-123',
    email: 'owner@example.test',
    email_verified: true,
  })
  const identity = await authenticate({ headers: { authorization: 'Bearer signed.token' } })
  assert.deepEqual(identity, {
    issuer: config.oidcIssuer,
    subject: 'subject-123',
    email: 'owner@example.test',
    emailVerified: true,
  })
  assert.equal(Object.isFrozen(identity), true)
})

test('does not expose an unverified email claim as verified', async () => {
  const authenticate = verifierFor({
    iss: config.oidcIssuer,
    sub: 'subject-123',
    email: 'unverified@example.test',
    email_verified: false,
  })
  const identity = await authenticate({ headers: { authorization: 'Bearer signed.token' } })
  assert.equal(identity.email, null)
  assert.equal(identity.emailVerified, false)
})

test('does not expose an email when the provider omits email_verified', async () => {
  const authenticate = verifierFor({
    iss: config.oidcIssuer,
    sub: 'subject-123',
    email: 'unknown@example.test',
  })
  const identity = await authenticate({ headers: { authorization: 'Bearer signed.token' } })
  assert.equal(identity.email, null)
  assert.equal(identity.emailVerified, false)
})

test('rejects missing subject even when a verified email is present', async () => {
  const authenticate = verifierFor({
    iss: config.oidcIssuer,
    email: 'owner@example.test',
    email_verified: true,
  })
  await assert.rejects(
    authenticate({ headers: { authorization: 'Bearer signed.token' } }),
    error => error.statusCode === 401,
  )
})

test('rejects requests without a bearer token', async () => {
  const authenticate = verifierFor({ iss: config.oidcIssuer, sub: 'subject-123' })
  await assert.rejects(authenticate({ headers: {} }), error => error.statusCode === 401)
})

test('requires complete OIDC verification configuration', () => {
  assert.throws(() => createOidcIdentityVerifier({}), /not configured/)
})


test('can verify an ID token against a separate browser-client audience', async () => {
  let verifiedAudience
  const authenticate = createOidcIdentityVerifier(config, {
    audience: 'platform-core-browser-client',
    jwks: {},
    verify: async (_token, _keySet, options) => {
      verifiedAudience = options.audience
      return { payload: { iss: config.oidcIssuer, sub: 'subject-123', email: 'owner@example.test', email_verified: true } }
    },
  })
  const identity = await authenticate({ headers: { authorization: 'Bearer signed.id.token' } })
  assert.equal(verifiedAudience, 'platform-core-browser-client')
  assert.equal(identity.emailVerified, true)
})
