import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.mjs'

test('uses safe development defaults', () => {
  assert.deepEqual(loadConfig({}), {
    host: '0.0.0.0',
    port: 8787,
    environment: 'development',
    oidcIssuer: '',
    oidcAudience: '',
    oidcClientId: '',
    oidcJwksUrl: '',
    adminIssuer: '',
    adminSubject: '',
    adminAuthConfigured: false,
    objectStorage: null,
  })
})

test('accepts a valid configured port', () => {
  assert.equal(loadConfig({ API_PORT: '9000' }).port, 9000)
})

test('rejects an invalid port', () => {
  assert.throws(() => loadConfig({ API_PORT: '70000' }), /API_PORT/)
})

test('keeps OIDC authentication disabled when no provider is configured', () => {
  assert.equal(loadConfig({}).adminAuthConfigured, false)
})

test('accepts complete HTTPS OIDC configuration', () => {
  const config = loadConfig({
    OIDC_ISSUER: 'https://identity.example.test/',
    OIDC_AUDIENCE: 'platform-core-api',
    OIDC_CLIENT_ID: 'platform-core-browser-client',
    OIDC_JWKS_URL: 'https://identity.example.test/.well-known/jwks.json',
    PLATFORM_ADMIN_SUBJECT: 'owner-subject',
  })
  assert.equal(config.adminAuthConfigured, true)
  assert.equal(config.adminIssuer, 'https://identity.example.test/')
  assert.equal(config.oidcClientId, 'platform-core-browser-client')
})

test('rejects partial OIDC configuration', () => {
  assert.throws(() => loadConfig({ OIDC_ISSUER: 'https://identity.example.test/' }), /must be configured together/)
})

test('rejects insecure OIDC URLs', () => {
  assert.throws(() => loadConfig({
    OIDC_ISSUER: 'http://identity.example.test/',
    OIDC_AUDIENCE: 'platform-core',
    OIDC_CLIENT_ID: 'platform-core-browser-client',
    OIDC_JWKS_URL: 'https://identity.example.test/jwks',
    PLATFORM_ADMIN_SUBJECT: 'owner-subject',
  }), /HTTPS/)
})

const storageEnv = {
  OBJECT_STORAGE_ENDPOINT: 'https://objects.example.test',
  OBJECT_STORAGE_BUCKET: 'private-restaurant-media',
  OBJECT_STORAGE_REGION: 'ap-south-1',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'ACCESSKEY12345678',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'a-secret-key-that-is-long-enough',
}

test('object storage remains optional when no credentials are configured', () => {
  assert.equal(loadConfig({}).objectStorage, null)
})

test('accepts a complete private S3-compatible storage configuration', () => {
  const storage = loadConfig(storageEnv).objectStorage
  assert.equal(storage.bucket, 'private-restaurant-media')
  assert.equal(storage.region, 'ap-south-1')
  assert.equal(storage.endpoint, 'https://objects.example.test')
})

test('rejects partial object storage configuration', () => {
  assert.throws(() => loadConfig({ OBJECT_STORAGE_BUCKET: 'private-restaurant-media' }), /must be configured together/)
})

test('rejects non-HTTPS object storage endpoints', () => {
  assert.throws(() => loadConfig({ ...storageEnv, OBJECT_STORAGE_ENDPOINT: 'http://objects.example.test' }), /HTTPS/)
})

test('rejects unsafe bucket names', () => {
  assert.throws(() => loadConfig({ ...storageEnv, OBJECT_STORAGE_BUCKET: '../public' }), /BUCKET is invalid/)
})

test('requires the browser client ID with the rest of OIDC configuration', () => {
  assert.throws(() => loadConfig({
    OIDC_ISSUER: 'https://identity.example.test/',
    OIDC_AUDIENCE: 'platform-core-api',
    OIDC_JWKS_URL: 'https://identity.example.test/jwks',
    PLATFORM_ADMIN_SUBJECT: 'owner-subject',
  }), /OIDC_CLIENT_ID/)
})
