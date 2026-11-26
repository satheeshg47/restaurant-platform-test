import test, { before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import worker from './index.ts'
import { handleRestaurantDataExport } from './restaurant-export.ts'
import { decryptTotpSecret, generateTotpCode, hashPassword } from './native-auth-crypto.ts'

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.values = [] }
  bind(...values) { this.values = values; return this }
  all() {
    const results = this.db.prepare(this.sql).all(...this.values)
    const meta = this.db.prepare('SELECT changes() AS changes').get()
    return { results, success: true, meta: { changes: Number(meta.changes) } }
  }
  first() { return this.db.prepare(this.sql).get(...this.values) ?? null }
  run() {
    const result = this.db.prepare(this.sql).run(...this.values)
    return { results: [], success: true, meta: { changes: Number(result.changes) } }
  }
}

function d1(db) {
  return {
    prepare(sql) { return new Statement(db, sql) },
    batch(statements) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map(statement => statement.all())
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

let privateKey
let jwksServer
let issuer
let jwksUrl
let env
let db
let tenantId
const audience = 'https://platform-core-api'
const clientId = 'PZuFV2NqKcO0yVvwTIHNWSkt8EWl19CX'
const adminSubject = 'auth0|platform-admin'

before(async () => {
  const keys = await generateKeyPair('RS256', { modulusLength: 2048 })
  privateKey = keys.privateKey
  const jwk = await exportJWK(keys.publicKey)
  Object.assign(jwk, { kid: 'worker-test-key', alg: 'RS256', use: 'sig' })
  jwksServer = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' })
    response.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise(resolve => jwksServer.listen(0, '127.0.0.1', resolve))
  const address = jwksServer.address()
  issuer = `http://127.0.0.1:${address.port}/`
  jwksUrl = `http://127.0.0.1:${address.port}/.well-known/jwks.json`
})

after(async () => {
  if (jwksServer) await new Promise(resolve => jwksServer.close(resolve))
})

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(readFileSync('database/d1/migrations/0001_platform_core.sql', 'utf8'))
  db.exec(readFileSync('database/d1/migrations/0002_owner_communication_centre.sql', 'utf8'))
  db.exec(readFileSync('database/d1/migrations/0003_restaurant_domain.sql', 'utf8'))
  db.exec(readFileSync('database/d1/migrations/0004_restaurant_order_item_timing.sql', 'utf8'))
  db.exec(readFileSync('database/d1/migrations/0005_seed_restaurant_application.sql', 'utf8'))
  db.exec(readFileSync('database/d1/migrations/0006_stock_adjustment_marker.sql', 'utf8'))
  db.exec(readFileSync('database/d1/migrations/0007_tenant_restore_guard.sql', 'utf8'))
  db.exec(readFileSync('database/d1/migrations/0008_native_auth_foundation.sql', 'utf8'))
  db.exec(readFileSync('database/d1/migrations/0009_totp_replay_protection.sql', 'utf8'))
  db.exec('CREATE TABLE d1_migrations (name TEXT PRIMARY KEY)')
  db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').run(
    '0001_platform_core.sql'
  )
  for (const name of [
    '0002_owner_communication_centre.sql',
    '0003_restaurant_domain.sql',
    '0004_restaurant_order_item_timing.sql',
    '0005_seed_restaurant_application.sql',
    '0006_stock_adjustment_marker.sql',
    '0007_tenant_restore_guard.sql',
    '0008_native_auth_foundation.sql',
    '0009_totp_replay_protection.sql',
  ]) db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').run(name)
  tenantId = crypto.randomUUID()
  db.prepare('INSERT INTO tenants(id,name,slug,status) VALUES(?,?,?,?)').run(tenantId, 'Test Restaurant', 'test-restaurant', 'active')
  env = {
    DB: d1(db),
    ASSETS: { fetch: async () => new Response('asset') },
    OIDC_ISSUER: issuer,
    OIDC_AUDIENCE: audience,
    OIDC_CLIENT_ID: clientId,
    OIDC_JWKS_URL: jwksUrl,
    PLATFORM_ADMIN_SUBJECT: adminSubject,
    AUTH_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    AUTH_BOOTSTRAP_SECRET: 'test-only-one-time-bootstrap-secret',
    ENVIRONMENT: 'test',
  }
})

afterEach(() => { db?.close() })

async function token(subject, aud, claims = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'worker-test-key' })
    .setIssuer(issuer)
    .setAudience(aud)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

async function call(path, { method = 'GET', accessToken, idToken, body, cookie, origin } = {}) {
  const headers = new Headers({ Accept: 'application/json' })
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  if (idToken) headers.set('X-OIDC-ID-Token', idToken)
  if (cookie) headers.set('Cookie', cookie)
  if (origin) headers.set('Origin', origin)
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  return worker.fetch(new Request(`https://platform.test/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
}

test('native Super Admin bootstrap, TOTP enrollment, login, recovery and session revocation work', async () => {
  const initialSession = await call('/auth/session')
  const initialStatus = await initialSession.json()
  assert.equal(initialSession.status, 200)
  assert.equal(initialStatus.authenticated, false)
  assert.equal(initialStatus.bootstrap_available, true)
  assert.equal(initialStatus.encryption_ready, true)

  const badBootstrap = await call('/auth/bootstrap-admin', {
    method: 'POST', body: { bootstrap_secret: 'wrong', login_id: 'root-admin', password: 'a-long-password-value-123' },
  })
  assert.equal(badBootstrap.status, 401)

  const invalidLoginId = await call('/auth/bootstrap-admin', {
    method: 'POST', body: { bootstrap_secret: 'test-only-one-time-bootstrap-secret', login_id: 'root admin', password: 'a-long-password-value-123' },
  })
  assert.equal(invalidLoginId.status, 400)
  assert.equal((await invalidLoginId.json()).error, 'invalid_login_id_format')

  const invalidPassword = await call('/auth/bootstrap-admin', {
    method: 'POST', body: { bootstrap_secret: 'test-only-one-time-bootstrap-secret', login_id: 'root-admin', password: 'short' },
  })
  assert.equal(invalidPassword.status, 400)
  assert.equal((await invalidPassword.json()).error, 'invalid_password_length')

  const invalidEmail = await call('/auth/bootstrap-admin', {
    method: 'POST', body: { bootstrap_secret: 'test-only-one-time-bootstrap-secret', login_id: 'root-admin', password: 'a-long-password-value-123', email: 'not-an-email' },
  })
  assert.equal(invalidEmail.status, 400)
  assert.equal((await invalidEmail.json()).error, 'invalid_email_format')

  const bootstrap = await call('/auth/bootstrap-admin', {
    method: 'POST', body: { bootstrap_secret: 'test-only-one-time-bootstrap-secret', login_id: 'root-admin', password: 'a-long-password-value-123', email: 'admin@example.test' },
  })
  assert.equal(bootstrap.status, 201)
  const afterBootstrap = await call('/auth/session')
  assert.equal((await afterBootstrap.json()).bootstrap_available, false)
  const duplicate = await call('/auth/bootstrap-admin', {
    method: 'POST', body: { bootstrap_secret: 'test-only-one-time-bootstrap-secret', login_id: 'other-admin', password: 'a-long-password-value-123' },
  })
  assert.equal(duplicate.status, 409)

  const login = await call('/auth/login', {
    method: 'POST', body: { login_id: 'ROOT-ADMIN', password: 'a-long-password-value-123' },
  })
  assert.equal(login.status, 200)
  const enrollment = await login.json()
  assert.equal(enrollment.totp_enrollment_required, true)
  const enrollmentSecret = new URL(enrollment.provisioning_uri).searchParams.get('secret')
  assert.ok(enrollmentSecret)
  const enrollmentCode = await generateTotpCode(enrollmentSecret)
  const enrolled = await call('/auth/totp/enroll/verify', {
    method: 'POST', body: { challenge_token: enrollment.challenge_token, code: enrollmentCode },
  })
  assert.equal(enrolled.status, 200)
  const enrollmentResult = await enrolled.json()
  assert.equal(enrollmentResult.authenticated, true)
  assert.equal(enrollmentResult.recovery_codes.length, 10)
  const firstCookie = enrolled.headers.get('Set-Cookie').split(';')[0]
  assert.match(enrolled.headers.get('Set-Cookie'), /HttpOnly/)
  assert.match(enrolled.headers.get('Set-Cookie'), /SameSite=Lax/)

  const adminSession = await call('/admin/session', { cookie: firstCookie })
  assert.equal(adminSession.status, 200)
  assert.equal((await adminSession.json()).admin.issuer, 'native')
  const nativeSessionStatus = await call('/auth/session', { cookie: firstCookie })
  const nativeSessionPayload = await nativeSessionStatus.json()
  assert.equal(nativeSessionPayload.authenticated, true)
  assert.equal(nativeSessionPayload.user.is_admin, true)

  const secondLogin = await call('/auth/login', {
    method: 'POST', body: { login_id: 'root-admin', password: 'a-long-password-value-123' },
  })
  assert.equal(secondLogin.status, 200)
  const mfa = await secondLogin.json()
  assert.equal(mfa.mfa_required, true)
  const stored = db.prepare('SELECT totp_secret_ciphertext FROM platform_user_credentials').get()
  const secret = await decryptTotpSecret(stored.totp_secret_ciphertext, env.AUTH_ENCRYPTION_KEY)
  const otp = await generateTotpCode(secret, Date.now() + 30_000)
  const verified = await call('/auth/totp/verify', {
    method: 'POST', body: { challenge_token: mfa.challenge_token, code: otp },
  })
  assert.equal(verified.status, 200)
  const secondCookie = verified.headers.get('Set-Cookie').split(';')[0]
  assert.equal((await call('/admin/session', { cookie: secondCookie })).status, 200)

  const replayLogin = await call('/auth/login', {
    method: 'POST', body: { login_id: 'root-admin', password: 'a-long-password-value-123' },
  })
  const replayChallenge = await replayLogin.json()
  const replayedOtp = await call('/auth/totp/verify', {
    method: 'POST', body: { challenge_token: replayChallenge.challenge_token, code: otp },
  })
  assert.equal(replayedOtp.status, 401, 'a TOTP counter must not be accepted twice')

  const recoveryLogin = await call('/auth/login', {
    method: 'POST', body: { login_id: 'root-admin', password: 'a-long-password-value-123' },
  })
  const recoveryChallenge = await recoveryLogin.json()
  const recoveryCode = enrollmentResult.recovery_codes[0]
  const recoveryVerified = await call('/auth/totp/verify', {
    method: 'POST', body: { challenge_token: recoveryChallenge.challenge_token, code: recoveryCode.toLowerCase() },
  })
  assert.equal(recoveryVerified.status, 200)

  const reuseLogin = await call('/auth/login', {
    method: 'POST', body: { login_id: 'root-admin', password: 'a-long-password-value-123' },
  })
  const reuseChallenge = await reuseLogin.json()
  const reused = await call('/auth/totp/verify', {
    method: 'POST', body: { challenge_token: reuseChallenge.challenge_token, code: recoveryCode },
  })
  assert.equal(reused.status, 401)

  const signedOut = await call('/auth/logout', { method: 'POST', cookie: secondCookie })
  assert.equal(signedOut.status, 200)
  assert.equal((await call('/admin/session', { cookie: secondCookie })).status, 401)
  const afterLogout = await call('/auth/session', { cookie: secondCookie })
  assert.equal((await afterLogout.json()).authenticated, false)
})

test('native authentication rejects cross-origin login requests', async () => {
  const response = await call('/auth/login', {
    method: 'POST', origin: 'https://attacker.example', body: { login_id: 'root-admin', password: 'not-a-real-password' },
  })
  assert.equal(response.status, 403)
})

test('cookie-authenticated state changes reject cross-origin requests before authorization', async () => {
  const response = await call('/admin/applications', {
    method: 'POST',
    cookie: 'platformcore_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    origin: 'https://attacker.example',
    body: { app_key: 'cross-site-test', name: 'Cross Site Test' },
  })
  assert.equal(response.status, 403)
})

test('D1 health, readiness and protected Super Admin session work', async () => {
  const health = await call('/health')
  assert.equal(health.status, 200)
  assert.equal((await health.json()).service, 'platform-core-api')

  const ready = await call('/ready')
  assert.equal(ready.status, 200)
  const readiness = await ready.json()
  assert.equal(readiness.checks.schema, 'complete')
  assert.equal(readiness.latest_migration, '0009_totp_replay_protection.sql')

  const unauthorized = await call('/admin/session')
  assert.equal(unauthorized.status, 401)

  const adminToken = await token(adminSubject, audience)
  const session = await call('/admin/session', { accessToken: adminToken })
  assert.equal(session.status, 200)
  assert.equal((await session.json()).admin.subject, adminSubject)

  const app = await call('/admin/applications', {
    method: 'POST', accessToken: adminToken, body: { app_key: 'test-app', name: 'Test App' },
  })
  assert.equal(app.status, 201)
  assert.equal(db.prepare('SELECT count(*) AS count FROM platform_audit_events').get().count, 1)
})

test('Super Admin release registry is authenticated and hides artifact storage keys', async () => {
  const unauthorized = await call('/admin/releases')
  assert.equal(unauthorized.status, 401)

  const application = db.prepare("SELECT id FROM applications WHERE app_key='restaurant'").get()
  assert.ok(application)
  const releaseId = crypto.randomUUID()
  const manifest = { schema_version: 1, app_key: 'restaurant', version: '1.2.3', database_migration_version: 7, files: [{ path: 'index.html', sha256: 'a'.repeat(64), size_bytes: 12 }] }
  db.prepare(`INSERT INTO application_releases (id,application_id,version,package_object_key,package_sha256,manifest,status)
    VALUES (?,?,?,?,?,?,?)`).run(releaseId, application.id, '1.2.3', 'private/internal/object-key', 'a'.repeat(64), JSON.stringify(manifest), 'uploaded')
  db.prepare(`INSERT INTO application_deployments (id,application_id,release_id,environment,status,health_report)
    VALUES (?,?,?,?,?,?)`).run(crypto.randomUUID(), application.id, releaseId, 'staging', 'healthy', JSON.stringify({ readiness: 'passed' }))

  const adminToken = await token(adminSubject, audience)
  const response = await call('/admin/releases', { accessToken: adminToken })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.releases.length, 1)
  assert.equal(payload.releases[0].version, '1.2.3')
  assert.equal(payload.releases[0].manifest.files[0].path, 'index.html')
  assert.equal('package_object_key' in payload.releases[0], false)
  assert.equal(payload.deployments.length, 1)
  assert.equal(payload.deployments[0].health_report.readiness, 'passed')
})

test('release manifest preflight validates metadata without storing or deploying a package', async () => {
  const adminToken = await token(adminSubject,audience)
  const manifest = {schema_version:1,app_key:'restaurant',version:'1.2.3',database_migration_version:7,files:[{path:'index.html',sha256:'a'.repeat(64),size_bytes:12}]}
  const valid = await call('/admin/releases/validate-manifest',{method:'POST',accessToken:adminToken,body:{manifest}})
  assert.equal(valid.status,200)
  const result=await valid.json()
  assert.equal(result.valid,true)
  assert.equal(result.checks.migration_compatible,true)
  assert.equal(result.total_bytes,12)
  assert.equal(db.prepare('SELECT count(*) AS count FROM application_releases').get().count,0)
  const unsafe=await call('/admin/releases/validate-manifest',{method:'POST',accessToken:adminToken,body:{manifest:{...manifest,version:'1.2.4',files:[{...manifest.files[0],path:'../tenant-data/private.json'}]}}})
  assert.equal(unsafe.status,400)
  assert.equal((await unsafe.json()).errors[0].code,'unsafe_file_path')
  const future=await call('/admin/releases/validate-manifest',{method:'POST',accessToken:adminToken,body:{manifest:{...manifest,version:'1.2.5',database_migration_version:10}}})
  assert.equal(future.status,409)
  assert.equal((await future.json()).error,'database_migration_not_available')
  const unauthorized=await call('/admin/releases/validate-manifest',{method:'POST',body:{manifest}})
  assert.equal(unauthorized.status,401)
})
test('D1 readiness fails closed when production schema migrations are absent', async () => {
  db.exec('DROP TABLE d1_migrations')
  const ready = await call('/ready')
  assert.equal(ready.status, 503)
  const payload = await ready.json()
  assert.equal(payload.status, 'not_ready')
  assert.equal(payload.checks.schema, 'incomplete')
})

test('Auth0 multi-audience access tokens validate azp against the SPA client ID', async () => {
  const validToken = await token(adminSubject, [audience, issuer + 'userinfo'], { azp: clientId })
  const validSession = await call('/admin/session', { accessToken: validToken })
  assert.equal(validSession.status, 200)

  const wrongClientToken = await token(adminSubject, [audience, issuer + 'userinfo'], { azp: 'another-client-id' })
  const rejectedSession = await call('/admin/session', { accessToken: wrongClientToken })
  assert.equal(rejectedSession.status, 401)
})

test('Super Admin manages subscription plans, manual payments and subscription lifecycle', async () => {
  const adminToken = await token(adminSubject,audience)
  const application = db.prepare("SELECT id FROM applications WHERE app_key='restaurant'").get()
  assert.ok(application)
  const planResponse = await call('/admin/subscription-plans',{method:'POST',accessToken:adminToken,body:{
    application_id:application.id,plan_code:'starter-monthly',display_name:'Starter Monthly',billing_interval:'monthly',amount_minor:50000,currency:'INR',trial_days:7,
  }})
  assert.equal(planResponse.status,201)
  const plan=(await planResponse.json()).plan
  const plans=await call('/admin/subscription-plans',{accessToken:adminToken})
  assert.equal(plans.status,200)
  assert.ok((await plans.json()).plans.some(item=>item.id===plan.id))
  const subscriptionResponse=await call('/admin/subscriptions',{method:'POST',accessToken:adminToken,body:{tenant_id:tenantId,application_id:application.id,plan_id:plan.id}})
  assert.equal(subscriptionResponse.status,201)
  const subscription=(await subscriptionResponse.json()).subscription
  assert.equal(subscription.status,'trial')
  const duplicate=await call('/admin/subscriptions',{method:'POST',accessToken:adminToken,body:{tenant_id:tenantId,application_id:application.id,plan_id:plan.id}})
  assert.equal(duplicate.status,409)
  const cardPayment=await call(`/admin/subscriptions/${subscription.id}/payments`,{method:'POST',accessToken:adminToken,body:{amount_minor:50000,payment_method:'card'}})
  assert.equal(cardPayment.status,400)
  const paymentResponse=await call(`/admin/subscriptions/${subscription.id}/payments`,{method:'POST',accessToken:adminToken,body:{amount_minor:50000,payment_method:'upi',provider_reference:'UTR-12345'}})
  assert.equal(paymentResponse.status,201)
  const payment=(await paymentResponse.json()).payment
  assert.equal(payment.status,'submitted')
  const confirmed=await call(`/admin/subscription-payments/${payment.id}/confirm`,{method:'POST',accessToken:adminToken})
  assert.equal(confirmed.status,200)
  assert.equal((await confirmed.json()).subscription.status,'active')
  const paymentList=await call(`/admin/subscriptions/${subscription.id}/payments`,{accessToken:adminToken})
  assert.equal((await paymentList.json()).payments[0].status,'confirmed')
  const subscriptions=await call('/admin/subscriptions',{accessToken:adminToken})
  assert.equal((await subscriptions.json()).subscriptions[0].status,'active')
  const cancelled=await call(`/admin/subscriptions/${subscription.id}`,{method:'PATCH',accessToken:adminToken,body:{status:'cancelled'}})
  assert.equal(cancelled.status,200)
  const afterCancel=await call(`/admin/subscriptions/${subscription.id}/payments`,{method:'POST',accessToken:adminToken,body:{amount_minor:50000,payment_method:'cash'}})
  assert.equal(afterCancel.status,409)
  const archived=await call(`/admin/subscription-plans/${plan.id}`,{method:'PATCH',accessToken:adminToken,body:{is_active:false}})
  assert.equal(archived.status,200)
  assert.equal((await archived.json()).plan.is_active,0)
})

test('Super Admin manages subscription plans, manual payments and subscription lifecycle', async () => {
  const adminToken = await token(adminSubject,audience)
  const application = db.prepare("SELECT id FROM applications WHERE app_key='restaurant'").get()
  assert.ok(application)
  const planResponse = await call('/admin/subscription-plans',{method:'POST',accessToken:adminToken,body:{
    application_id:application.id,plan_code:'starter-monthly',display_name:'Starter Monthly',billing_interval:'monthly',amount_minor:50000,currency:'INR',trial_days:7,
  }})
  assert.equal(planResponse.status,201)
  const plan=(await planResponse.json()).plan
  const plans=await call('/admin/subscription-plans',{accessToken:adminToken})
  assert.equal(plans.status,200)
  assert.ok((await plans.json()).plans.some(item=>item.id===plan.id))
  const subscriptionResponse=await call('/admin/subscriptions',{method:'POST',accessToken:adminToken,body:{tenant_id:tenantId,application_id:application.id,plan_id:plan.id}})
  assert.equal(subscriptionResponse.status,201)
  const subscription=(await subscriptionResponse.json()).subscription
  assert.equal(subscription.status,'trial')
  const duplicate=await call('/admin/subscriptions',{method:'POST',accessToken:adminToken,body:{tenant_id:tenantId,application_id:application.id,plan_id:plan.id}})
  assert.equal(duplicate.status,409)
  const cardPayment=await call(`/admin/subscriptions/${subscription.id}/payments`,{method:'POST',accessToken:adminToken,body:{amount_minor:50000,payment_method:'card'}})
  assert.equal(cardPayment.status,400)
  const paymentResponse=await call(`/admin/subscriptions/${subscription.id}/payments`,{method:'POST',accessToken:adminToken,body:{amount_minor:50000,payment_method:'upi',provider_reference:'UTR-12345'}})
  assert.equal(paymentResponse.status,201)
  const payment=(await paymentResponse.json()).payment
  assert.equal(payment.status,'submitted')
  const confirmed=await call(`/admin/subscription-payments/${payment.id}/confirm`,{method:'POST',accessToken:adminToken})
  assert.equal(confirmed.status,200)
  assert.equal((await confirmed.json()).subscription.status,'active')
  const paymentList=await call(`/admin/subscriptions/${subscription.id}/payments`,{accessToken:adminToken})
  assert.equal((await paymentList.json()).payments[0].status,'confirmed')
  const subscriptions=await call('/admin/subscriptions',{accessToken:adminToken})
  assert.equal((await subscriptions.json()).subscriptions[0].status,'active')
  const cancelled=await call(`/admin/subscriptions/${subscription.id}`,{method:'PATCH',accessToken:adminToken,body:{status:'cancelled'}})
  assert.equal(cancelled.status,200)
  const afterCancel=await call(`/admin/subscriptions/${subscription.id}/payments`,{method:'POST',accessToken:adminToken,body:{amount_minor:50000,payment_method:'cash'}})
  assert.equal(afterCancel.status,409)
  const archived=await call(`/admin/subscription-plans/${plan.id}`,{method:'PATCH',accessToken:adminToken,body:{is_active:false}})
  assert.equal(archived.status,200)
  assert.equal((await archived.json()).plan.is_active,0)
})

test('Super Admin monitoring reports application, billing and deployment health', async () => {
  const adminToken = await token(adminSubject,audience)
  const response = await call('/admin/monitoring',{accessToken:adminToken})
  assert.equal(response.status,200)
  const data=await response.json()
  assert.ok(data.generated_at)
  assert.equal(typeof data.counts.active_applications,'number')
  assert.equal(typeof data.counts.active_tenants,'number')
  assert.equal(typeof data.counts.payments_awaiting_review,'number')
  assert.equal(typeof data.counts.failed_deployments,'number')
  assert.ok(Array.isArray(data.recent_events))
  assert.ok(Array.isArray(data.recent_deployments))
  assert.equal(data.usage_metrics.available,false)
})

test('owner invitation requires matching verified identity and creates one active owner', async () => {
  const adminToken = await token(adminSubject, audience)
  const created = await call('/admin/owner-invitations', {
    method: 'POST', accessToken: adminToken,
    body: { tenant_id: tenantId, email: 'owner@example.com' },
  })
  assert.equal(created.status, 201)
  const invitation = await created.json()
  assert.match(invitation.token, /^[A-Za-z0-9_-]{43}$/)

  const ownerSubject = 'auth0|restaurant-owner'
  const ownerAccess = await token(ownerSubject, audience)
  const wrongEmailId = await token(ownerSubject, clientId, { email: 'wrong@example.com', email_verified: true })
  const mismatch = await call('/owner/invitations/accept', {
    method: 'POST', accessToken: ownerAccess, idToken: wrongEmailId, body: { token: invitation.token },
  })
  assert.equal(mismatch.status, 403)
  assert.equal(db.prepare('SELECT status FROM platform_owner_invitations').get().status, 'pending')

  const ownerId = await token(ownerSubject, clientId, { email: 'owner@example.com', email_verified: true })
  const accepted = await call('/owner/invitations/accept', {
    method: 'POST', accessToken: ownerAccess, idToken: ownerId, body: { token: invitation.token },
  })
  assert.equal(accepted.status, 200)
  assert.equal((await accepted.json()).accepted, true)
  assert.equal(db.prepare("SELECT count(*) AS count FROM tenant_memberships WHERE tenant_id=? AND role='owner' AND status='active'").get(tenantId).count, 1)
  assert.equal(db.prepare('SELECT status FROM platform_owner_invitations').get().status, 'accepted')

  const duplicate = await call('/admin/owner-invitations', {
    method: 'POST', accessToken: adminToken,
    body: { tenant_id: tenantId, email: 'second@example.com' },
  })
  assert.equal(duplicate.status, 409)
})

test('owner invitation can create an individual native owner account and require TOTP', async () => {
  const adminToken = await token(adminSubject, audience)
  const created = await call('/admin/owner-invitations', {
    method: 'POST', accessToken: adminToken,
    body: { tenant_id: tenantId, email: 'native-owner@example.test' },
  })
  assert.equal(created.status, 201)
  const invitation = await created.json()

  const accepted = await call('/owner/invitations/accept', {
    method: 'POST',
    body: { token: invitation.token, login_id: 'native-owner', password: 'owner-password-strong-123' },
  })
  assert.equal(accepted.status, 200)
  const acceptedPayload = await accepted.json()
  assert.equal(acceptedPayload.accepted, true)
  assert.equal(acceptedPayload.account_created, true)

  const user = db.prepare("SELECT id FROM platform_users WHERE auth_provider='native' AND email=?").get('native-owner@example.test')
  assert.ok(user?.id)
  const credential = db.prepare('SELECT login_id_normalized FROM platform_user_credentials WHERE user_id=?').get(user.id)
  assert.equal(credential.login_id_normalized, 'native-owner')
  assert.equal(db.prepare("SELECT role FROM tenant_memberships WHERE tenant_id=? AND user_id=? AND status='active'").get(tenantId, user.id).role, 'owner')

  const login = await call('/auth/login', {
    method: 'POST', body: { login_id: 'NATIVE-OWNER', password: 'owner-password-strong-123' },
  })
  assert.equal(login.status, 200)
  const payload = await login.json()
  assert.equal(payload.totp_enrollment_required, true)
  assert.ok(payload.provisioning_uri)
})

test('owner can create, manage and suspend individual staff logins', async () => {
  const ownerId = crypto.randomUUID()
  const ownerPassword = 'native-owner-password-123'
  const ownerHash = await hashPassword(ownerPassword)
  db.prepare("INSERT INTO platform_users(id,auth_provider,auth_subject,email) VALUES(?,'native',?,?)").run(ownerId, ownerId, 'staff-owner@example.test')
  db.prepare('INSERT INTO platform_user_credentials(user_id,login_id,login_id_normalized,password_hash) VALUES(?,?,?,?)').run(ownerId, 'restaurant-owner', 'restaurant-owner', ownerHash)
  db.prepare("INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(?,?,'owner','active')").run(tenantId, ownerId)

  const ownerLogin = await call('/auth/login', { method: 'POST', body: { login_id: 'restaurant-owner', password: ownerPassword } })
  assert.equal(ownerLogin.status, 200)
  const ownerChallenge = await ownerLogin.json()
  const setupSecret = new URL(ownerChallenge.provisioning_uri).searchParams.get('secret')
  const ownerCode = await generateTotpCode(setupSecret)
  const ownerEnrolled = await call('/auth/totp/enroll/verify', {
    method: 'POST', body: { challenge_token: ownerChallenge.challenge_token, code: ownerCode },
  })
  assert.equal(ownerEnrolled.status, 200)
  const ownerCookie = ownerEnrolled.headers.get('Set-Cookie').split(';')[0]

  const created = await call('/owner/staff', {
    method: 'POST', cookie: ownerCookie,
    body: { tenant_id: tenantId, login_id: 'cook.one', display_name: 'Kitchen Cook', password: 'cook-password-strong-123', role: 'cook' },
  })
  assert.equal(created.status, 201)
  const createdPayload = await created.json()
  assert.equal(createdPayload.staff.role, 'cook')
  const staffRow = db.prepare("SELECT id,user_id FROM restaurant_staff WHERE tenant_id=? AND username='cook.one'").get(tenantId)
  assert.ok(staffRow?.id)

  const listed = await call('/owner/staff?tenant_id=' + tenantId, { cookie: ownerCookie })
  assert.equal(listed.status, 200)
  assert.equal((await listed.json()).staff.length, 1)

  const staffLogin = await call('/auth/login', { method: 'POST', body: { login_id: 'cook.one', password: 'cook-password-strong-123' } })
  assert.equal(staffLogin.status, 200)
  assert.equal((await staffLogin.json()).authenticated, true)
  const staffCookie = staffLogin.headers.get('Set-Cookie').split(';')[0]
  const staffSession = await call('/auth/session', { cookie: staffCookie })
  const staffSessionPayload = await staffSession.json()
  assert.equal(staffSessionPayload.user.tenant_role, 'staff')
  assert.equal(staffSessionPayload.user.memberships[0].staff_role, 'cook')

  const suspended = await call('/owner/staff/' + staffRow.id, {
    method: 'PATCH', cookie: ownerCookie, body: { tenant_id: tenantId, active: false },
  })
  assert.equal(suspended.status, 200)
  assert.equal((await call('/auth/session', { cookie: staffCookie })).status, 200)
  const rejectedLogin = await call('/auth/login', { method: 'POST', body: { login_id: 'cook.one', password: 'cook-password-strong-123' } })
  assert.equal(rejectedLogin.status, 401)

  const reactivated = await call('/owner/staff/' + staffRow.id, {
    method: 'PATCH', cookie: ownerCookie, body: { tenant_id: tenantId, active: true, role: 'manager' },
  })
  assert.equal(reactivated.status, 200)
  const reLogin = await call('/auth/login', { method: 'POST', body: { login_id: 'cook.one', password: 'cook-password-strong-123' } })
  assert.equal(reLogin.status, 200)
})

test('owner support conversations and admin replies are tenant-scoped', async () => {
  const adminToken = await token(adminSubject, audience)
  const inviteResponse = await call('/admin/owner-invitations', {
    method: 'POST', accessToken: adminToken,
    body: { tenant_id: tenantId, email: 'owner@example.com' },
  })
  const invite = await inviteResponse.json()
  const ownerSubject = 'auth0|owner-support'
  const ownerAccess = await token(ownerSubject, audience)
  const ownerId = await token(ownerSubject, clientId, { email: 'owner@example.com', email_verified: true })
  const accepted = await call('/owner/invitations/accept', {
    method: 'POST', accessToken: ownerAccess, idToken: ownerId, body: { token: invite.token },
  })
  assert.equal(accepted.status, 200)

  const created = await call('/owner/communications', {
    method: 'POST', accessToken: ownerAccess,
    body: { subject: 'Need help', message: 'Please help with setup.' },
  })
  assert.equal(created.status, 201)
  const conversationId = (await created.json()).message.conversation_id

  const adminInbox = await call('/admin/communications', { accessToken: adminToken })
  assert.equal(adminInbox.status, 200)
  assert.equal((await adminInbox.json()).conversations.length, 1)

  const reply = await call(`/admin/communications/${conversationId}/messages`, {
    method: 'POST', accessToken: adminToken, body: { message: 'We can help.' },
  })
  assert.equal(reply.status, 201)

  const ownerMessages = await call(`/owner/communications/${conversationId}`, { accessToken: ownerAccess })
  assert.equal(ownerMessages.status, 200)
  const messages = (await ownerMessages.json()).messages
  assert.equal(messages.length, 2)
  assert.equal(messages[1].body, 'We can help.')

  const ownerTenants = await call('/owner/communications/tenants', { accessToken: ownerAccess })
  assert.equal(ownerTenants.status, 200)
  assert.equal((await ownerTenants.json()).tenants.length, 1)

  const denied = await call(`/owner/communications/${crypto.randomUUID()}`, { accessToken: ownerAccess })
  assert.equal(denied.status, 404)
})

test('admin announcements reach only selected active owners', async () => {
  const adminToken = await token(adminSubject, audience)
  const inviteResponse = await call('/admin/owner-invitations', {
    method: 'POST', accessToken: adminToken,
    body: { tenant_id: tenantId, email: 'owner@example.com' },
  })
  const invite = await inviteResponse.json()
  const ownerSubject = 'auth0|owner-announcement'
  const ownerAccess = await token(ownerSubject, audience)
  const ownerId = await token(ownerSubject, clientId, { email: 'owner@example.com', email_verified: true })
  const accepted = await call('/owner/invitations/accept', {
    method: 'POST', accessToken: ownerAccess, idToken: ownerId, body: { token: invite.token },
  })
  assert.equal(accepted.status, 200)
  const owner = db.prepare('SELECT id FROM platform_users WHERE auth_subject=?').get(ownerSubject)

  const broadcast = await call('/admin/communications', {
    method: 'POST', accessToken: adminToken,
    body: { kind: 'announcement', subject: 'Service update', message: 'A scheduled update.', user_ids: [owner.id] },
  })
  assert.equal(broadcast.status, 201)

  const inbox = await call('/owner/communications', { accessToken: ownerAccess })
  assert.equal(inbox.status, 200)
  const conversations = (await inbox.json()).conversations
  assert.equal(conversations.length, 1)
  assert.equal(conversations[0].kind, 'announcement')
})

test('D1 restaurant schema includes tenant-scoped operations, GST invoices and item timing', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'restaurant_%' ORDER BY name").all().map(row => row.name)
  assert.equal(tables.length, 26)
  assert.ok(tables.includes('restaurant_tenant_controls'))
  for (const table of ['restaurant_profiles','restaurant_staff','restaurant_tables','restaurant_table_sessions','restaurant_menu_categories','restaurant_menu_items','restaurant_orders','restaurant_order_items','restaurant_kitchen_batches','restaurant_payments','restaurant_refunds','restaurant_service_requests','restaurant_reviews','restaurant_invoice_counters','restaurant_invoices']) {
    assert.ok(tables.includes(table), `missing ${table}`)
  }
  const menuColumns = db.prepare('PRAGMA table_info(restaurant_menu_items)').all().map(row => row.name)
  assert.ok(menuColumns.includes('last_stock_adjustment_id'))
  const itemColumns = db.prepare('PRAGMA table_info(restaurant_order_items)').all().map(row => row.name)
  for (const column of ['preparation_started_at','ready_at','served_at','unavailable_at','cancelled_at']) {
    assert.ok(itemColumns.includes(column), `missing order-item timing column ${column}`)
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('D1 restore atomically restores rows and regenerates private QR tokens', async () => {
  const restoreTenantId = crypto.randomUUID()
  db.prepare('INSERT INTO tenants(id,name,slug,status) VALUES(?,?,?,?)').run(restoreTenantId,'Restore Target','restore-target','active')
  const tableId = crypto.randomUUID()
  db.prepare('INSERT INTO restaurant_tables(id,tenant_id,label,table_type) VALUES(?,?,?,?)').run(tableId,restoreTenantId,'Restored Table','dine_in')
  db.prepare("INSERT INTO restaurant_settings(tenant_id,setting_key,setting_value) VALUES(?,?,?)").run(restoreTenantId,'restore_test','{"ok":true}')
  const actor = { tenantId: restoreTenantId, userId: 'restore-test-user', staffId: null, role: 'owner' }
  const parts = ['restaurant','restore-target','data-export','backup']
  const backupResponse = await handleRestaurantDataExport(new Request('https://example.test/backup'),env,actor,parts)
  assert.equal(backupResponse.status,200)
  const backup = await backupResponse.json()
  assert.equal(backup.row_count,2)
  assert.equal(backup.tables.restaurant_tables[0].public_token_hash,undefined)
  db.prepare('DELETE FROM restaurant_tables WHERE tenant_id=?').run(restoreTenantId)
  db.prepare('DELETE FROM restaurant_settings WHERE tenant_id=?').run(restoreTenantId)
  const missingConfirmation = await handleRestaurantDataExport(new Request('https://example.test/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(backup)}),env,actor,['restaurant','restore-target','data-export','restore'])
  assert.equal(missingConfirmation.status,400)
  const restored = await handleRestaurantDataExport(new Request('https://example.test/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...backup,confirmation:'RESTORE restore-target'})}),env,actor,['restaurant','restore-target','data-export','restore'])
  assert.equal(restored.status,200)
  const result = await restored.json()
  assert.equal(result.restored,true)
  assert.equal(result.row_count,2)
  assert.equal(result.regenerated_qr_tokens.length,1)
  const token = result.regenerated_qr_tokens[0].qr_token
  assert.equal(token.length,43)
  const stored = db.prepare('SELECT public_token_hash FROM restaurant_tables WHERE tenant_id=? AND id=?').get(restoreTenantId,tableId)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))
  assert.equal(stored.public_token_hash,[...digest].map(x=>x.toString(16).padStart(2,'0')).join(''))
  assert.equal(db.prepare('SELECT setting_value FROM restaurant_settings WHERE tenant_id=? AND setting_key=?').get(restoreTenantId,'restore_test').setting_value,'{"ok":true}')
  assert.equal(db.prepare('SELECT count(*) AS count FROM restaurant_tenant_controls WHERE tenant_id=?').get(restoreTenantId).count,0)
})

test('Super Admin can create a tenant, invite its owner and manage restaurant settings and tables', async () => {
  const adminToken = await token(adminSubject, audience)
  const created = await call('/admin/tenants', {
    method: 'POST', accessToken: adminToken,
    body: { name: 'Green Leaf Kitchen', slug: 'green-leaf-kitchen' },
  })
  assert.equal(created.status, 201)
  const tenant = (await created.json()).tenant
  assert.equal(tenant.slug, 'green-leaf-kitchen')
  assert.equal(db.prepare("SELECT count(*) AS count FROM tenant_applications WHERE tenant_id=? AND status='active'").get(tenant.id).count, 1)
  assert.equal(db.prepare('SELECT display_name FROM restaurant_profiles WHERE tenant_id=?').get(tenant.id).display_name, 'Green Leaf Kitchen')

  const inviteResponse = await call('/admin/owner-invitations', {
    method: 'POST', accessToken: adminToken,
    body: { tenant_id: tenant.id, email: 'tenant-owner@example.com' },
  })
  assert.equal(inviteResponse.status, 201)
  const invite = await inviteResponse.json()
  const ownerSubject = 'auth0|tenant-owner'
  const ownerAccess = await token(ownerSubject, audience)
  const ownerId = await token(ownerSubject, clientId, { email: 'tenant-owner@example.com', email_verified: true })
  const accepted = await call('/owner/invitations/accept', {
    method: 'POST', accessToken: ownerAccess, idToken: ownerId, body: { token: invite.token },
  })
  assert.equal(accepted.status, 200)

  const ownerRestaurants = await call('/owner/restaurants', { accessToken: ownerAccess })
  assert.equal(ownerRestaurants.status, 200)
  const ownerDirectory = await ownerRestaurants.json()
  assert.equal(ownerDirectory.restaurants.length, 1)
  assert.equal(ownerDirectory.restaurants[0].tenant_slug, 'green-leaf-kitchen')
  assert.equal(ownerDirectory.restaurants[0].display_name, 'Green Leaf Kitchen')
  const anonymousDirectory = await call('/owner/restaurants')
  assert.equal(anonymousDirectory.status, 401)

  const settings = await call('/restaurant/green-leaf-kitchen/settings', { accessToken: ownerAccess })
  assert.equal(settings.status, 200)
  assert.equal((await settings.json()).settings.display_name, 'Green Leaf Kitchen')

  const saved = await call('/restaurant/green-leaf-kitchen/settings', {
    method: 'PATCH', accessToken: ownerAccess,
    body: {
      display_name: 'Green Leaf Foods', currency_code: 'INR', timezone: 'Asia/Kolkata',
      default_language: 'kn', tax_mode: 'gst', tax_rate: 0, gst_rate: 5,
      tax_inclusive: false, accepting_orders: true, legal_name: 'Green Leaf Foods Pvt Ltd',
      gstin: '29ABCDE1234F1Z5', address_line1: '123 Main Street', address_line2: '',
      city: 'Bengaluru', state_name: 'Karnataka', state_code: '29', postal_code: '560001',
      invoice_prefix: 'GLF',
    },
  })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).settings.gstin, '29ABCDE1234F1Z5')

  const categoryResponse = await call('/restaurant/green-leaf-kitchen/menu/categories', {
    method: 'POST', accessToken: ownerAccess,
    body: { name: { en: 'Starters', kn: 'ಪ್ರಾರಂಭಿಕ' }, sort_order: 1, station: 'Kitchen', schedule: {} },
  })
  assert.equal(categoryResponse.status, 201)
  const category = (await categoryResponse.json()).category
  assert.equal(category.name.en, 'Starters')

  const itemResponse = await call('/restaurant/green-leaf-kitchen/menu/items', {
    method: 'POST', accessToken: ownerAccess,
    body: {
      category_id: category.id, name: { en: 'Paneer Tikka' }, description: { en: 'Grilled paneer' },
      base_price_minor: 25000, food_type: 'veg', prep_minutes: 15, priority: 1,
      available: true, stock_tracking: true, stock_quantity: 10, low_stock_at: 2,
      schedule: {}, sort_order: 1, active: true, hsn_sac_code: '210690',
    },
  })
  assert.equal(itemResponse.status, 201)
  const item = (await itemResponse.json()).item
  assert.equal(item.stock_quantity, 10)

  const variantResponse = await call(`/restaurant/green-leaf-kitchen/menu/items/${item.id}/variants`, {
    method: 'POST', accessToken: ownerAccess, body: { name: { en: 'Half' }, price_minor: 15000 },
  })
  assert.equal(variantResponse.status, 201)

  const groupResponse = await call('/restaurant/green-leaf-kitchen/menu/addon-groups', {
    method: 'POST', accessToken: ownerAccess,
    body: { name: { en: 'Extras' }, required: false, min_pick: 0, max_pick: 2 },
  })
  assert.equal(groupResponse.status, 201)
  const group = (await groupResponse.json()).addon_group
  const addonResponse = await call(`/restaurant/green-leaf-kitchen/menu/addon-groups/${group.id}/addons`, {
    method: 'POST', accessToken: ownerAccess, body: { name: { en: 'Cheese' }, price_minor: 5000 },
  })
  assert.equal(addonResponse.status, 201)
  const linkResponse = await call(`/restaurant/green-leaf-kitchen/menu/items/${item.id}/addon-groups`, {
    method: 'POST', accessToken: ownerAccess, body: { group_id: group.id },
  })
  assert.equal(linkResponse.status, 201)

  const menuResponse = await call('/restaurant/green-leaf-kitchen/menu', { accessToken: ownerAccess })
  assert.equal(menuResponse.status, 200)
  const menu = await menuResponse.json()
  assert.equal(menu.categories.length, 1)
  assert.equal(menu.items.length, 1)
  assert.equal(menu.variants.length, 1)
  assert.equal(menu.addon_groups.length, 1)
  assert.equal(menu.addons.length, 1)
  assert.equal(menu.item_addon_groups.length, 1)

  const adjustment = await call(`/restaurant/green-leaf-kitchen/menu/items/${item.id}/stock-adjustments`, {
    method: 'POST', accessToken: ownerAccess, body: { quantity_delta: 2, reason: 'New stock received' },
  })
  assert.equal(adjustment.status, 200)
  assert.equal((await adjustment.json()).stock.new_quantity, 12)
  const insufficient = await call(`/restaurant/green-leaf-kitchen/menu/items/${item.id}/stock-adjustments`, {
    method: 'POST', accessToken: ownerAccess, body: { quantity_delta: -20, reason: 'Test overdraw' },
  })
  assert.equal(insufficient.status, 409)
  const events = await call(`/restaurant/green-leaf-kitchen/menu/items/${item.id}/stock-adjustments`, { accessToken: ownerAccess })
  assert.equal(events.status, 200)
  assert.equal((await events.json()).events.length, 1)

  const unlink = await call(`/restaurant/green-leaf-kitchen/menu/items/${item.id}/addon-groups/${group.id}`, {
    method: 'DELETE', accessToken: ownerAccess,
  })
  assert.equal(unlink.status, 200)

  const tableResponse = await call('/restaurant/green-leaf-kitchen/tables', {
    method: 'POST', accessToken: ownerAccess,
    body: { label: 'Table 1', table_type: 'dine_in', table_number: 1 },
  })
  assert.equal(tableResponse.status, 201)
  const table = await tableResponse.json()
  assert.match(table.qr_token, /^[A-Za-z0-9_-]{43}$/)

  const deactivated = await call(`/restaurant/green-leaf-kitchen/tables/${table.table.id}`, {
    method: 'PATCH', accessToken: ownerAccess, body: { active: false },
  })
  assert.equal(deactivated.status, 200)
  assert.equal((await deactivated.json()).table.active, false)
  const reactivated = await call(`/restaurant/green-leaf-kitchen/tables/${table.table.id}`, {
    method: 'PATCH', accessToken: ownerAccess, body: { active: true },
  })
  assert.equal(reactivated.status, 200)
  assert.equal((await reactivated.json()).table.active, true)

  const opened = await call(`/restaurant/green-leaf-kitchen/tables/${table.table.id}/sessions`, {
    method: 'POST', accessToken: ownerAccess, body: { guest_count: 4 },
  })
  assert.equal(opened.status, 201)
  const session = (await opened.json()).session
  const blockedDeactivate = await call(`/restaurant/green-leaf-kitchen/tables/${table.table.id}`, {
    method: 'PATCH', accessToken: ownerAccess, body: { active: false },
  })
  assert.equal(blockedDeactivate.status, 409)
  assert.equal((await blockedDeactivate.json()).error, 'table_has_open_session')

  const orderId = crypto.randomUUID()
  db.prepare(`INSERT INTO restaurant_orders(id,tenant_id,order_number,table_id,session_id,status,subtotal_minor,tax_minor,total_minor,source,idempotency_key)
    VALUES(?,?,?,?,?,'new',100,0,100,'qr',?)`).run(orderId, tenant.id, 1, table.table.id, session.id, 'session-test-order')
  const blockedUnfinished = await call(`/restaurant/green-leaf-kitchen/tables/${table.table.id}/sessions/${session.id}/close`, {
    method: 'POST', accessToken: ownerAccess,
  })
  assert.equal(blockedUnfinished.status, 409)
  assert.equal((await blockedUnfinished.json()).error, 'orders_not_completed')
  db.prepare("UPDATE restaurant_orders SET status='served' WHERE tenant_id=? AND id=?").run(tenant.id, orderId)
  const blockedUnpaid = await call(`/restaurant/green-leaf-kitchen/tables/${table.table.id}/sessions/${session.id}/close`, {
    method: 'POST', accessToken: ownerAccess,
  })
  assert.equal(blockedUnpaid.status, 409)
  assert.equal((await blockedUnpaid.json()).error, 'payment_due')
  db.prepare(`INSERT INTO restaurant_payments(tenant_id,session_id,table_id,amount_minor,method)
    VALUES(?,?,?,100,'cash')`).run(tenant.id, session.id, table.table.id)

  const qrMenu = await call(`/restaurant/green-leaf-kitchen/guest/${table.qr_token}/menu`)
  assert.equal(qrMenu.status, 200)
  const guestData = await qrMenu.json()
  assert.equal(guestData.table.id, table.table.id)
  assert.equal(guestData.session.id, session.id)
  assert.equal(guestData.restaurant.display_name, 'Green Leaf Foods')
  assert.equal(guestData.categories.length, 1)
  assert.equal(guestData.items.length, 1)
  assert.equal(guestData.categories[0].items.length, 1)
  assert.equal(guestData.categories[0].items[0].id, item.id)

  const selectedVariant = db.prepare('SELECT id FROM restaurant_menu_variants WHERE tenant_id=? AND item_id=?').get(tenant.id, item.id)
  const orderPayload = { session_id: session.id, idempotency_key: 'guest-order-test-0001', note: '  No   onions  ', items: [{ item_id: item.id, variant_id: selectedVariant.id, quantity: 2 }] }
  const guestOrderPath = `/restaurant/green-leaf-kitchen/guest/${table.qr_token}/orders`
  const placed = await call(guestOrderPath, { method: 'POST', body: orderPayload })
  assert.equal(placed.status, 201)
  const placedBody = await placed.json()
  assert.equal(placedBody.order.subtotal_minor, 30000)
  assert.equal(placedBody.order.tax_minor, 1500)
  assert.equal(placedBody.order.total_minor, 31500)
  assert.equal(db.prepare('SELECT special_instructions FROM restaurant_orders WHERE tenant_id=? AND id=?').get(tenant.id, placedBody.order.id).special_instructions, 'No onions')
  assert.equal(db.prepare('SELECT stock_quantity FROM restaurant_menu_items WHERE tenant_id=? AND id=?').get(tenant.id, item.id).stock_quantity, 10)
  assert.equal(db.prepare('SELECT count(*) AS count FROM restaurant_kitchen_batches WHERE tenant_id=?').get(tenant.id).count, 1)
  assert.equal(db.prepare('SELECT count(*) AS count FROM restaurant_batch_allocations WHERE tenant_id=?').get(tenant.id).count, 1)
  const duplicate = await call(guestOrderPath, { method: 'POST', body: orderPayload })
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json()).order.id, placedBody.order.id)
  const guestOrderStatus = await call(`/restaurant/green-leaf-kitchen/guest/${table.qr_token}/orders/${placedBody.order.id}`)
  assert.equal(guestOrderStatus.status, 200)
  assert.equal((await guestOrderStatus.json()).items.length, 1)
  const cancellationRequest = await call(`/restaurant/green-leaf-kitchen/guest/${table.qr_token}/orders/${placedBody.order.id}/cancel`, {
    method: 'POST', body: { session_id: session.id },
  })
  assert.equal(cancellationRequest.status, 201)
  assert.equal((await cancellationRequest.json()).request.status, 'open')
  const guestServiceRequest = await call(`/restaurant/green-leaf-kitchen/guest/${table.qr_token}/requests`, {
    method: 'POST', body: { session_id: session.id, request_type: 'need_water', note: 'Please bring water' },
  })
  assert.equal(guestServiceRequest.status, 201)
  assert.equal((await guestServiceRequest.json()).request.status, 'open')
  assert.equal(db.prepare('SELECT count(*) AS count FROM restaurant_orders WHERE tenant_id=? AND session_id=?').get(tenant.id, session.id).count, 2)
  const orderItemId = db.prepare('SELECT id FROM restaurant_order_items WHERE tenant_id=? AND order_id=?').get(tenant.id, placedBody.order.id).id
  const queue = await call('/restaurant/green-leaf-kitchen/kitchen/queue', { accessToken: ownerAccess })
  assert.equal(queue.status, 200)
  assert.equal((await queue.json()).queue.length, 1)
  for (const status of ['accepted','preparing','ready']) {
    const changed = await call(`/restaurant/green-leaf-kitchen/kitchen/items/${orderItemId}/status`, { method: 'PATCH', accessToken: ownerAccess, body: { status } })
    assert.equal(changed.status, 200)
  }
  const board = await call('/restaurant/green-leaf-kitchen/waiter/board', { accessToken: ownerAccess })
  assert.equal(board.status, 200)
  assert.equal((await board.json()).ready_items.length, 1)
  const served = await call(`/restaurant/green-leaf-kitchen/waiter/items/${orderItemId}/serve`, { method: 'POST', accessToken: ownerAccess })
  assert.equal(served.status, 200)
  assert.equal((await served.json()).order_status, 'served')
  const payment = await call(`/restaurant/green-leaf-kitchen/waiter/sessions/${session.id}/payments`, { method: 'POST', accessToken: ownerAccess, body: { amount_minor: '31500', method: 'cash' } })
  assert.equal(payment.status, 201)
  const overpayment = await call(`/restaurant/green-leaf-kitchen/waiter/sessions/${session.id}/payments`, { method: 'POST', accessToken: ownerAccess, body: { amount_minor: '1', method: 'cash' } })
  assert.equal(overpayment.status, 409)
  const refund = await call(`/restaurant/green-leaf-kitchen/waiter/sessions/${session.id}/refunds`, { method: 'POST', accessToken: ownerAccess, body: { amount_minor: '100', order_id: orderId, reason: 'Test refund', was_paid: true } })
  assert.equal(refund.status, 201)
  const settlement = await call(`/restaurant/green-leaf-kitchen/waiter/sessions/${session.id}/payments`, { method: 'POST', accessToken: ownerAccess, body: { amount_minor: '100', method: 'cash' } })
  assert.equal(settlement.status, 201)
  const bill = await call(`/restaurant/green-leaf-kitchen/waiter/sessions/${session.id}/bill`, { accessToken: ownerAccess })
  assert.equal(bill.status, 200)
  const billBody = await bill.json()
  assert.equal(billBody.payments.length, 3)
  assert.equal(billBody.refunds.length, 1)
  const serviceRequest = db.prepare("INSERT INTO restaurant_service_requests(tenant_id,session_id,table_id,request_type,note) VALUES(?,?,?,'other','Please bring water') RETURNING id").get(tenant.id, session.id, table.table.id)
  const handledRequest = await call(`/restaurant/green-leaf-kitchen/waiter/requests/${serviceRequest.id}`, { method: 'PATCH', accessToken: ownerAccess, body: { status: 'handled' } })
  assert.equal(handledRequest.status, 200)
  assert.equal((await handledRequest.json()).request.status, 'handled')

  const closed = await call(`/restaurant/green-leaf-kitchen/tables/${table.table.id}/sessions/${session.id}/close`, {
    method: 'POST', accessToken: ownerAccess,
  })
  assert.equal(closed.status, 200)
  assert.equal((await closed.json()).session.status, 'closed')

  const tableList = await call('/restaurant/green-leaf-kitchen/tables', { accessToken: ownerAccess })
  assert.equal(tableList.status, 200)
  assert.equal((await tableList.json()).tables[0].session_id, null)

  const invoiceTableResponse = await call('/restaurant/green-leaf-kitchen/tables', {
    method: 'POST', accessToken: ownerAccess, body: { label: 'Invoice Table', table_type: 'dine_in', table_number: 2 },
  })
  assert.equal(invoiceTableResponse.status, 201)
  const invoiceTable = await invoiceTableResponse.json()
  const invoiceSessionResponse = await call(`/restaurant/green-leaf-kitchen/tables/${invoiceTable.table.id}/sessions`, {
    method: 'POST', accessToken: ownerAccess, body: { guest_count: 2 },
  })
  assert.equal(invoiceSessionResponse.status, 201)
  const invoiceSession = (await invoiceSessionResponse.json()).session
  const invoiceOrderId = crypto.randomUUID()
  const nextOrderNumber = db.prepare('SELECT COALESCE(MAX(order_number),0)+1 AS n FROM restaurant_orders WHERE tenant_id=?').get(tenant.id).n
  db.prepare(`INSERT INTO restaurant_orders(id,tenant_id,order_number,table_id,session_id,status,subtotal_minor,tax_minor,total_minor,source,idempotency_key,tax_mode_snapshot,tax_rate_snapshot,tax_inclusive_snapshot)
    VALUES(?,?,?,?,?,'served',1000,50,1050,'waiter','invoice-test','gst',5,0)`).run(invoiceOrderId,tenant.id,nextOrderNumber,invoiceTable.table.id,invoiceSession.id)
  db.prepare(`INSERT INTO restaurant_order_items(tenant_id,order_id,item_id,category_id,item_name_snapshot,quantity,unit_price_minor,addons_price_minor,line_total_minor,status)
    VALUES(?,?,?,?,?,1,1000,0,1000,'served')`).run(tenant.id,invoiceOrderId,item.id,category.id,'Paneer Tikka')
  const invoicePayment = await call(`/restaurant/green-leaf-kitchen/waiter/sessions/${invoiceSession.id}/payments`, {
    method: 'POST', accessToken: ownerAccess, body: { amount_minor: '1050', method: 'cash' },
  })
  assert.equal(invoicePayment.status, 201)
  const invoiceResponse = await call(`/restaurant/green-leaf-kitchen/waiter/sessions/${invoiceSession.id}/invoice`, {
    method: 'POST', accessToken: ownerAccess,
  })
  assert.equal(invoiceResponse.status, 201)
  const invoiceBody = await invoiceResponse.json()
  assert.equal(invoiceBody.invoice.total_minor, 1050)
  assert.equal(invoiceBody.invoice.cgst_minor, 25)
  assert.equal(invoiceBody.invoice.sgst_minor, 25)
  assert.equal(invoiceBody.invoice.seller_snapshot.gstin, '29ABCDE1234F1Z5')
  const duplicateInvoice = await call(`/restaurant/green-leaf-kitchen/waiter/sessions/${invoiceSession.id}/invoice`, { method: 'POST', accessToken: ownerAccess })
  assert.equal(duplicateInvoice.status, 200)
  assert.equal((await duplicateInvoice.json()).invoice.id, invoiceBody.invoice.id)
  assert.equal(db.prepare('SELECT status FROM restaurant_table_sessions WHERE tenant_id=? AND id=?').get(tenant.id,invoiceSession.id).status,'closed')
  const reportDay = db.prepare("SELECT date('now','+5 hours','+30 minutes') AS day").get().day
  const report = await call(`/restaurant/green-leaf-kitchen/reports?from=${reportDay}&to=${reportDay}`, { accessToken: ownerAccess })
  assert.equal(report.status, 200)
  assert.ok((await report.json()).summary.order_count >= 1)
  const archived = await call(`/restaurant/green-leaf-kitchen/daily-summary?date=${reportDay}`, { method: 'POST', accessToken: ownerAccess })
  assert.equal(archived.status, 200)
  assert.equal((await archived.json()).archived, true)
  const savedSummary = await call(`/restaurant/green-leaf-kitchen/daily-summary?date=${reportDay}`, { accessToken: ownerAccess })
  assert.equal(savedSummary.status, 200)
  assert.ok((await savedSummary.json()).summary.order_count >= 1)
  const reviewEligibility = await call(`/restaurant/green-leaf-kitchen/guest/${invoiceTable.qr_token}/reviews`)
  assert.equal(reviewEligibility.status, 200)
  assert.equal((await reviewEligibility.json()).review_session.id, invoiceSession.id)
  const guestReview = await call(`/restaurant/green-leaf-kitchen/guest/${invoiceTable.qr_token}/reviews`, {
    method: 'POST', body: { session_id: invoiceSession.id, rating: 5, comment: 'Excellent service' },
  })
  assert.equal(guestReview.status, 201)
  const reviewBody = await guestReview.json()
  assert.equal(reviewBody.review.rating, 5)
  const duplicateReview = await call(`/restaurant/green-leaf-kitchen/guest/${invoiceTable.qr_token}/reviews`, {
    method: 'POST', body: { session_id: invoiceSession.id, rating: 4 },
  })
  assert.equal(duplicateReview.status, 409)
  const reviewList = await call('/restaurant/green-leaf-kitchen/reviews', { accessToken: ownerAccess })
  assert.equal(reviewList.status, 200)
  assert.equal((await reviewList.json()).reviews.length, 1)
  const reviewUpdate = await call(`/restaurant/green-leaf-kitchen/reviews/${reviewBody.review.id}`, {
    method: 'PATCH', accessToken: ownerAccess, body: { visibility: 'hidden', owner_response: 'Thank you for your feedback' },
  })
  assert.equal(reviewUpdate.status, 200)
  assert.equal((await reviewUpdate.json()).review.visibility, 'hidden')

  const exportCatalog = await call('/restaurant/green-leaf-kitchen/data-export', { accessToken: ownerAccess })
  assert.equal(exportCatalog.status, 200)
  assert.ok((await exportCatalog.json()).tables.some(t => t.name === 'restaurant_orders'))
  const backupResponse = await call('/restaurant/green-leaf-kitchen/data-export/backup', { accessToken: ownerAccess })
  assert.equal(backupResponse.status, 200)
  assert.match(backupResponse.headers.get('content-type'), /application\/json/)
  const backup = await backupResponse.json()
  assert.equal(backup.format, 'restaurant-platform-d1-backup')
  assert.ok(backup.row_count > 0)
  assert.equal(backup.tables.restaurant_tables[0].public_token_hash, undefined)
  assert.equal(backup.tables.restaurant_orders[0].idempotency_key, undefined)
  const adminCatalog = await call('/restaurant/green-leaf-kitchen/data-export', { accessToken: adminToken })
  assert.equal(adminCatalog.status, 200)
  const adminBackupResponse = await call('/restaurant/green-leaf-kitchen/data-export/backup', { accessToken: adminToken })
  assert.equal(adminBackupResponse.status, 200)
  const adminBackup = await adminBackupResponse.json()
  assert.equal(adminBackup.tenant_id, tenant.id)
  const adminPreflight = await call('/restaurant/green-leaf-kitchen/data-export/restore-preflight', {
    method: 'POST', accessToken: adminToken, body: adminBackup,
  })
  assert.equal(adminPreflight.status, 200)
  assert.equal((await adminPreflight.json()).restore_allowed, false)
  const adminBlockedRestore = await call('/restaurant/green-leaf-kitchen/data-export/restore', {
    method: 'POST', accessToken: adminToken,
    body: { ...adminBackup, confirmation: 'RESTORE green-leaf-kitchen' },
  })
  assert.equal(adminBlockedRestore.status, 409)
  assert.equal((await adminBlockedRestore.json()).error, 'restore_target_not_empty')
  const adminCsv = await call('/restaurant/green-leaf-kitchen/data-export/restaurant_orders', { accessToken: adminToken })
  assert.equal(adminCsv.status, 200)
  assert.match(adminCsv.headers.get('content-type'), /text\/csv/)
  assert.ok(db.prepare("SELECT count(*) AS count FROM platform_audit_events WHERE action IN ('tenant.data_export.accessed','tenant.backup.downloaded','tenant.restore.preflighted') AND resource_id=?").get(tenant.id).count >= 4)

  const backupValidation = await call('/restaurant/green-leaf-kitchen/data-export/validate-backup', {
    method: 'POST', accessToken: ownerAccess, body: backup,
  })
  assert.equal(backupValidation.status, 200)
  assert.equal((await backupValidation.json()).valid, true)
  const restorePreflight = await call('/restaurant/green-leaf-kitchen/data-export/restore-preflight', {
    method: 'POST', accessToken: ownerAccess, body: backup,
  })
  assert.equal(restorePreflight.status, 200)
  assert.equal((await restorePreflight.json()).restore_allowed, false)
  const blockedRestore = await call('/restaurant/green-leaf-kitchen/data-export/restore', {
    method: 'POST', accessToken: ownerAccess, body: { ...backup, confirmation: 'RESTORE green-leaf-kitchen' },
  })
  assert.equal(blockedRestore.status, 409)
  assert.equal((await blockedRestore.json()).error, 'restore_target_not_empty')
  assert.throws(() => db.prepare('INSERT INTO restaurant_tenant_controls(tenant_id,maintenance_mode,restore_mode) VALUES(?,1,1)').run(tenant.id), /restore_target_not_empty/)
  db.prepare('INSERT INTO restaurant_tenant_controls(tenant_id,maintenance_mode,restore_mode) VALUES(?,1,0)').run(tenant.id)
  assert.throws(() => db.prepare('UPDATE restaurant_profiles SET display_name=display_name WHERE tenant_id=?').run(tenant.id), /tenant_maintenance_locked/)
  db.prepare('DELETE FROM restaurant_tenant_controls WHERE tenant_id=?').run(tenant.id)
  const csvExport = await call('/restaurant/green-leaf-kitchen/data-export/restaurant_orders', { accessToken: ownerAccess })
  assert.equal(csvExport.status, 200)
  assert.match(csvExport.headers.get('content-type'), /text\/csv/)

  const otherTenant = await call('/admin/tenants', { method: 'POST', accessToken: adminToken, body: { name: 'Other Tenant', slug: 'other-tenant' } })
  assert.equal(otherTenant.status, 201)
  const forbidden = await call('/restaurant/other-tenant/settings', { accessToken: ownerAccess })
  assert.equal(forbidden.status, 403)

  const otherOwnerInviteResponse = await call('/admin/owner-invitations', {
    method: 'POST', accessToken: adminToken,
    body: { tenant_id: (await otherTenant.json()).tenant.id, email: 'other-owner@example.com' },
  })
  assert.equal(otherOwnerInviteResponse.status, 201)
  const otherOwnerInvite = await otherOwnerInviteResponse.json()
  const otherOwnerSubject = 'auth0|other-tenant-owner'
  const otherOwnerAccess = await token(otherOwnerSubject, audience)
  const otherOwnerId = await token(otherOwnerSubject, clientId, { email: 'other-owner@example.com', email_verified: true })
  const otherOwnerAccepted = await call('/owner/invitations/accept', {
    method: 'POST', accessToken: otherOwnerAccess, idToken: otherOwnerId,
    body: { token: otherOwnerInvite.token },
  })
  assert.equal(otherOwnerAccepted.status, 200)

  const otherOwnerOwnTenant = await call('/restaurant/other-tenant/settings', { accessToken: otherOwnerAccess })
  assert.equal(otherOwnerOwnTenant.status, 200)
  const reverseForbidden = await call('/restaurant/green-leaf-kitchen/settings', { accessToken: otherOwnerAccess })
  assert.equal(reverseForbidden.status, 403)
  const unauthenticated = await call('/restaurant/green-leaf-kitchen/settings')
  assert.equal(unauthenticated.status, 401)
})

test('Super Admin can suspend and reactivate a tenant with an audit trail', async () => {
  const adminToken = await token(adminSubject, audience)
  const unauthorized = await call(`/admin/tenants/${tenantId}/status`, { method: 'PATCH', body: { status: 'suspended' } })
  assert.equal(unauthorized.status, 401)

  const invalid = await call(`/admin/tenants/${tenantId}/status`, {
    method: 'PATCH', accessToken: adminToken, body: { status: 'closed' },
  })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error, 'invalid_tenant_status')

  const suspended = await call(`/admin/tenants/${tenantId}/status`, {
    method: 'PATCH', accessToken: adminToken, body: { status: 'suspended' },
  })
  assert.equal(suspended.status, 200)
  assert.equal((await suspended.json()).tenant.status, 'suspended')
  assert.equal(db.prepare('SELECT status FROM tenants WHERE id=?').get(tenantId).status, 'suspended')

  const unchanged = await call(`/admin/tenants/${tenantId}/status`, {
    method: 'PATCH', accessToken: adminToken, body: { status: 'suspended' },
  })
  assert.equal(unchanged.status, 200)
  assert.equal((await unchanged.json()).changed, false)

  const reactivated = await call(`/admin/tenants/${tenantId}/status`, {
    method: 'PATCH', accessToken: adminToken, body: { status: 'active' },
  })
  assert.equal(reactivated.status, 200)
  assert.equal((await reactivated.json()).tenant.status, 'active')
  assert.equal(db.prepare("SELECT count(*) AS count FROM platform_audit_events WHERE action='tenant.status_changed' AND resource_id=?").get(tenantId).count, 2)
})
