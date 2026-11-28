import type { Env, Identity } from './types.ts'
import {
  createTotpSecret, decryptTotpSecret, encryptTotpSecret, hashPassword,
  findTotpCounter, randomToken, sha256Hex, totpProvisioningUri, verifyPassword,
} from './native-auth-crypto.ts'

const encoder = new TextEncoder()
const SESSION_SECONDS = 12 * 60 * 60
const CHALLENGE_SECONDS = 5 * 60
const LOGIN_LIMIT = 10

type UserAuthRow = {
  id: string
  email: string | null
  login_id: string
  password_hash: string
  credential_status: string
  totp_secret_ciphertext: string | null
  totp_enabled: number
  is_admin: number
  is_owner: number
  is_member_active: number
}

function json(status: number, body: unknown, extra?: HeadersInit): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  new Headers(extra).forEach((value, key) => headers.set(key, value))
  return new Response(JSON.stringify(body), { status, headers })
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('Cookie') || ''
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) { try { return decodeURIComponent(part.slice(index + 1).trim()) } catch { return null } }
  }
  return null
}

function sessionCookie(token: string, request: Request): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `platformcore_session=${encodeURIComponent(token)}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`
}

function clearSessionCookie(request: Request): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `platformcore_session=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
}

function validOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin')
  if (!origin) return true
  try { return new URL(origin).origin === new URL(request.url).origin } catch { return false }
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get('Content-Length') || 0)
  if (length > 8192) return null
  const raw = await request.text()
  if (encoder.encode(raw).byteLength > 8192) return null
  try {
    const body: unknown = JSON.parse(raw)
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch { return null }
}

function sameSecret(a: string, b: string): boolean {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) difference |= (left[i] || 0) ^ (right[i] || 0)
  return difference === 0
}

async function consumeRateLimit(env: Env, key: string): Promise<boolean> {
  const bucket = await sha256Hex(key)
  const now = new Date().toISOString()
  const result = await env.DB.prepare(
    `INSERT INTO platform_auth_rate_limits(bucket_key,window_started_at,attempt_count,updated_at)
     VALUES(?,?,1,?)
     ON CONFLICT(bucket_key) DO UPDATE SET
       attempt_count=CASE WHEN platform_auth_rate_limits.window_started_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes') THEN 1 ELSE MIN(platform_auth_rate_limits.attempt_count+1,1000) END,
       window_started_at=CASE WHEN platform_auth_rate_limits.window_started_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes') THEN excluded.window_started_at ELSE platform_auth_rate_limits.window_started_at END,
       blocked_until=CASE
         WHEN platform_auth_rate_limits.blocked_until>excluded.updated_at THEN platform_auth_rate_limits.blocked_until
         WHEN platform_auth_rate_limits.window_started_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes') AND platform_auth_rate_limits.attempt_count>=?
           THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes')
         ELSE NULL END,
       updated_at=excluded.updated_at
     RETURNING attempt_count,blocked_until`,
  ).bind(bucket, now, now, LOGIN_LIMIT - 1).first<{ attempt_count: number; blocked_until: string | null }>()
  return !result?.blocked_until || result.blocked_until <= now
}

async function createChallenge(env: Env, userId: string, purpose: 'login_totp' | 'totp_enrollment'): Promise<string> {
  const token = randomToken(32)
  const id = crypto.randomUUID()
  const now = new Date()
  const expires = new Date(now.getTime() + CHALLENGE_SECONDS * 1000).toISOString()
  await env.DB.prepare(
    'INSERT INTO platform_auth_challenges(id,user_id,challenge_hash,purpose,expires_at) VALUES(?,?,?,?,?)',
  ).bind(id, userId, await sha256Hex(token), purpose, expires).run()
  return token
}

async function createSession(env: Env, userId: string, request: Request): Promise<{ token: string; cookie: string }> {
  const token = randomToken(32)
  const id = crypto.randomUUID()
  const now = new Date()
  const expires = new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString()
  const userAgent = request.headers.get('User-Agent') || ''
  await env.DB.prepare(
    'INSERT INTO platform_auth_sessions(id,user_id,token_hash,expires_at,user_agent_hash) VALUES(?,?,?,?,?)',
  ).bind(id, userId, await sha256Hex(token), expires, userAgent ? await sha256Hex(userAgent.slice(0, 512)) : null).run()
  return { token, cookie: sessionCookie(token, request) }
}

async function getUserAuth(env: Env, userId: string): Promise<UserAuthRow | null> {
  return env.DB.prepare(
    `SELECT pu.id,pu.email,c.login_id,c.password_hash,c.credential_status,c.totp_secret_ciphertext,c.totp_enabled,
       EXISTS(SELECT 1 FROM platform_admin_accounts aa WHERE aa.user_id=pu.id AND aa.status='active') AS is_admin,
       EXISTS(SELECT 1 FROM tenant_memberships tm WHERE tm.user_id=pu.id AND tm.status='active' AND tm.role IN ('owner','admin')) AS is_owner,
       EXISTS(SELECT 1 FROM tenant_memberships tm WHERE tm.user_id=pu.id AND tm.status='active') AS is_member_active
     FROM platform_users pu JOIN platform_user_credentials c ON c.user_id=pu.id WHERE pu.id=?`,
  ).bind(userId).first<UserAuthRow>()
}

async function identityForToken(env: Env, token: string): Promise<Identity | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  const row = await env.DB.prepare(
    `SELECT pu.id,pu.email FROM platform_auth_sessions s
     JOIN platform_users pu ON pu.id=s.user_id
     JOIN platform_user_credentials c ON c.user_id=pu.id
     WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?
       AND c.credential_status='active'
       AND (EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.user_id=pu.id AND tm.status='active') OR EXISTS (SELECT 1 FROM platform_admin_accounts aa WHERE aa.user_id=pu.id AND aa.status='active'))`,
  ).bind(await sha256Hex(token), new Date().toISOString()).first<{ id: string; email: string | null }>()
  if (!row) return null
  return { issuer: 'native', subject: row.id, ...(row.email ? { email: row.email } : {}), emailVerified: false }
}

export async function authenticateNativeSession(request: Request, env: Env): Promise<Identity | null> {
  const cookie = readCookie(request, 'platformcore_session')
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '')
  const token = cookie || bearer?.[1]
  if (!token) return null
  const primary = await identityForToken(env, token)
  if (primary) return primary
  return env.DEMO_DB ? identityForToken({ ...env, DB: env.DEMO_DB }, token) : null
}

async function verifyChallenge(env: Env, token: string, purpose: 'login_totp' | 'totp_enrollment') {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  return env.DB.prepare(
    `SELECT id,user_id,attempts FROM platform_auth_challenges
     WHERE challenge_hash=? AND purpose=? AND consumed_at IS NULL AND expires_at>?`,
  ).bind(await sha256Hex(token), purpose, new Date().toISOString()).first<{ id: string; user_id: string; attempts: number }>()
}

async function consumeChallenge(env: Env, id: string): Promise<boolean> {
  const result = await env.DB.prepare(
    'UPDATE platform_auth_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?',
  ).bind(new Date().toISOString(), id, new Date().toISOString()).run()
  return Number(result.meta?.changes || 0) === 1
}

async function recordBadChallenge(env: Env, id: string): Promise<void> {
  await env.DB.prepare('UPDATE platform_auth_challenges SET attempts=attempts+1 WHERE id=? AND consumed_at IS NULL AND attempts<10').bind(id).run()
}

async function completeLogin(env: Env, userId: string, request: Request): Promise<Response> {
  const session = await createSession(env, userId, request)
  await env.DB.prepare('UPDATE restaurant_staff SET last_login_at=? WHERE user_id=? AND active=1').bind(new Date().toISOString(), userId).run()
  return json(200, { authenticated: true, expires_in: SESSION_SECONDS }, { 'Set-Cookie': session.cookie })
}

async function bootstrapAdmin(request: Request, env: Env): Promise<Response> {
  if (!env.AUTH_BOOTSTRAP_SECRET) return json(503, { error: 'bootstrap_not_configured' })
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  if (!await consumeRateLimit(env, `bootstrap:${ip}`)) return json(429, { error: 'too_many_attempts' })
  const body = await readBody(request)
  if (!body) return json(400, { error: 'invalid_request' })
  const supplied = typeof body.bootstrap_secret === 'string' ? body.bootstrap_secret : ''
  if (!sameSecret(supplied, env.AUTH_BOOTSTRAP_SECRET)) return json(401, { error: 'unauthorized' })
  const loginId = typeof body.login_id === 'string' ? body.login_id.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(loginId)) return json(400, { error: 'invalid_login_id_format' })
  if (password.length < 12 || password.length > 256) return json(400, { error: 'invalid_password_length' })
  if (email && (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return json(400, { error: 'invalid_email_format' })
  const existing = await env.DB.prepare('SELECT count(*) AS count FROM platform_admin_accounts').first<{ count: number }>()
  if (Number(existing?.count || 0) !== 0) return json(409, { error: 'bootstrap_already_used' })
  const id = crypto.randomUUID()
  try {
    const passwordHash = await hashPassword(password)
    const results = await env.DB.batch([
      env.DB.prepare("INSERT INTO platform_users(id,auth_provider,auth_subject,email) SELECT ?,'native',?,? WHERE NOT EXISTS (SELECT 1 FROM platform_admin_accounts)").bind(id, id, email || null),
      env.DB.prepare('INSERT INTO platform_user_credentials(user_id,login_id,login_id_normalized,password_hash) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM platform_users WHERE id=?) AND NOT EXISTS (SELECT 1 FROM platform_admin_accounts)').bind(id, loginId, loginId.toLowerCase(), passwordHash, id),
      env.DB.prepare("INSERT INTO platform_admin_accounts(user_id,status) SELECT ?,'active' WHERE EXISTS (SELECT 1 FROM platform_user_credentials WHERE user_id=?) AND NOT EXISTS (SELECT 1 FROM platform_admin_accounts) RETURNING user_id").bind(id, id),
      env.DB.prepare("INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata) SELECT 'bootstrap','one-time-secret','platform.admin.bootstrap','platform_admin',?,'{}' WHERE EXISTS (SELECT 1 FROM platform_admin_accounts WHERE user_id=?)").bind(id, id),
    ])
    if (!results[2]?.results?.length) return json(409, { error: 'bootstrap_already_used' })
    return json(201, { created: true, login_id: loginId })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error'
    // Keep sensitive request data out of logs; this records only the server-side failure class.
    console.error('native_auth_bootstrap_failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: message.slice(0, 240),
    })
    return json(/UNIQUE|constraint/i.test(message) ? 409 : 500, { error: /UNIQUE|constraint/i.test(message) ? 'login_id_unavailable' : 'bootstrap_failed' })
  }
}

async function ensurePreviewDemoAdmin(env: Env): Promise<void> {
  if (env.ENVIRONMENT !== 'preview' || !env.DEMO_DB) return
  const db = env.DEMO_DB
  const userId = 'demo-platform-admin'
  const loginId = env.DEMO_ADMIN_LOGIN_ID || 'demo.admin'
  const existing = await db.prepare(`SELECT c.login_id,c.credential_status,aa.status AS admin_status
    FROM platform_user_credentials c
    JOIN platform_admin_accounts aa ON aa.user_id=c.user_id
    WHERE c.user_id=? LIMIT 1`).bind(userId).first<{ login_id: string; credential_status: string; admin_status: string }>()
  // Avoid writing and re-hashing on every demo admin login. This helper runs
  // before each preview sign-in, and repeated upserts quickly exhaust D1's
  // free daily row-write quota during browser QA.
  if (existing && existing.login_id === loginId && existing.credential_status === 'active' && existing.admin_status === 'active') return
  const passwordHash = await hashPassword('DemoAdmin#2026!')
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO platform_users(id,auth_provider,auth_subject,email) VALUES(?,'native',?,NULL)").bind(userId, userId),
    db.prepare("INSERT INTO platform_user_credentials(user_id,login_id,login_id_normalized,password_hash,credential_status) VALUES(?,?,?,?,'active') ON CONFLICT(user_id) DO UPDATE SET login_id=excluded.login_id,login_id_normalized=excluded.login_id_normalized,password_hash=excluded.password_hash,credential_status='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
      .bind(userId, loginId, loginId.toLowerCase(), passwordHash),
    db.prepare("INSERT INTO platform_admin_accounts(user_id,status) VALUES(?,'active') ON CONFLICT(user_id) DO UPDATE SET status='active'").bind(userId),
  ])
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request)
  if (!body) return json(400, { error: 'invalid_request' })
  const loginId = typeof body.login_id === 'string' ? body.login_id.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!loginId || loginId.length > 320 || password.length > 256) return json(401, { error: 'invalid_credentials' })
  const demoQaLogin = /^demo\.(admin|owner|cook|waiter|manager)$/.test(loginId.toLowerCase())
  if (demoQaLogin && env.ENVIRONMENT !== 'preview') return json(401, { error: 'invalid_credentials' })
  if (env.ENVIRONMENT === 'preview' && loginId.toLowerCase() === (env.DEMO_ADMIN_LOGIN_ID || 'demo.admin').toLowerCase()) {
    await ensurePreviewDemoAdmin(env)
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  const rateEnv = loginId.toLowerCase().startsWith('demo.') && env.DEMO_DB ? { ...env, DB: env.DEMO_DB } : env
  if (!await consumeRateLimit(rateEnv, `login:${loginId.toLowerCase()}:${ip}`)) return json(429, { error: 'too_many_attempts' })
  let authEnv = env
  let user = await env.DB.prepare(
    `SELECT pu.id,pu.email,c.login_id,c.password_hash,c.credential_status,c.totp_secret_ciphertext,c.totp_enabled,
       EXISTS(SELECT 1 FROM platform_admin_accounts aa WHERE aa.user_id=pu.id AND aa.status='active') AS is_admin,
       EXISTS(SELECT 1 FROM tenant_memberships tm WHERE tm.user_id=pu.id AND tm.status='active' AND tm.role IN ('owner','admin')) AS is_owner,
       EXISTS(SELECT 1 FROM tenant_memberships tm WHERE tm.user_id=pu.id AND tm.status='active') AS is_member_active
     FROM platform_user_credentials c JOIN platform_users pu ON pu.id=c.user_id
     WHERE c.login_id_normalized=? OR lower(pu.email)=? LIMIT 1`,
  ).bind(loginId.toLowerCase(), loginId.toLowerCase()).first<UserAuthRow>()
  if (!user && env.DEMO_DB) {
    authEnv = { ...env, DB: env.DEMO_DB }
    user = await authEnv.DB.prepare(
      `SELECT pu.id,pu.email,c.login_id,c.password_hash,c.credential_status,c.totp_secret_ciphertext,c.totp_enabled,
         EXISTS(SELECT 1 FROM platform_admin_accounts aa WHERE aa.user_id=pu.id AND aa.status='active') AS is_admin,
         EXISTS(SELECT 1 FROM tenant_memberships tm WHERE tm.user_id=pu.id AND tm.status='active' AND tm.role IN ('owner','admin')) AS is_owner,
         EXISTS(SELECT 1 FROM tenant_memberships tm WHERE tm.user_id=pu.id AND tm.status='active') AS is_member_active
       FROM platform_user_credentials c JOIN platform_users pu ON pu.id=c.user_id
       WHERE c.login_id_normalized=? LIMIT 1`,
    ).bind(loginId.toLowerCase()).first<UserAuthRow>()
  }
  const dummyHash = 'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const valid = await verifyPassword(password, user && user.credential_status === 'active' ? user.password_hash : dummyHash)
  if (!user || user.credential_status !== 'active' || !valid || (!Number(user.is_admin) && !Number(user.is_owner) && !Number(user.is_member_active))) return json(401, { error: 'invalid_credentials' })
  // Password verification is the only sign-in step. Existing encrypted TOTP
  // metadata is retained for backwards compatibility but is not required.
  return completeLogin(authEnv, user.id, request)
}

async function verifyMfa(request: Request, env: Env, enrollment: boolean): Promise<Response> {
  const body = await readBody(request)
  if (!body) return json(400, { error: 'invalid_request' })
  const token = typeof body.challenge_token === 'string' ? body.challenge_token : ''
  const code = typeof body.code === 'string' ? body.code.toUpperCase().replace(/\s/g, '') : ''
  const purpose = enrollment ? 'totp_enrollment' : 'login_totp'
  const challenge = await verifyChallenge(env, token, purpose)
  if (!challenge || challenge.attempts >= 10) return json(401, { error: 'invalid_or_expired_challenge' })
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  if (!await consumeRateLimit(env, `mfa:${challenge.user_id}:${ip}`)) return json(429, { error: 'too_many_attempts' })
  const user = await getUserAuth(env, challenge.user_id)
  if (!user || user.credential_status !== 'active' || !user.totp_secret_ciphertext || !env.AUTH_ENCRYPTION_KEY) return json(401, { error: 'invalid_or_expired_challenge' })
  let valid = false
  let matchedCounter: number | null = null
  if (/^\d{6}$/.test(code)) {
    try {
      const secret = await decryptTotpSecret(user.totp_secret_ciphertext, env.AUTH_ENCRYPTION_KEY)
      matchedCounter = await findTotpCounter(secret, code)
      valid = matchedCounter !== null
    } catch { valid = false }
  } else if (!enrollment && /^[A-Z0-9_-]{12}$/.test(code)) {
    const used = await env.DB.prepare(
      'UPDATE platform_auth_recovery_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL RETURNING id',
    ).bind(new Date().toISOString(), user.id, await sha256Hex(code)).first<{ id: string }>()
    valid = Boolean(used)
  }
  if (!valid) {
    await recordBadChallenge(env, challenge.id)
    return json(401, { error: 'invalid_code' })
  }
  if (!await consumeChallenge(env, challenge.id)) return json(409, { error: 'challenge_already_used' })
  if (matchedCounter !== null) {
    const now = new Date().toISOString()
    const counterUpdate = enrollment
      ? await env.DB.prepare(
          'UPDATE platform_user_credentials SET totp_enabled=1,totp_enrolled_at=?,totp_last_counter=?,updated_at=? WHERE user_id=? AND totp_enabled=0 RETURNING user_id',
        ).bind(now, matchedCounter, now, user.id).first<{ user_id: string }>()
      : await env.DB.prepare(
          'UPDATE platform_user_credentials SET totp_last_counter=?,updated_at=? WHERE user_id=? AND totp_enabled=1 AND (totp_last_counter IS NULL OR totp_last_counter<?) RETURNING user_id',
        ).bind(matchedCounter, now, user.id, matchedCounter).first<{ user_id: string }>()
    if (!counterUpdate) return json(401, { error: 'invalid_code' })
  }
  if (enrollment) {
    if (matchedCounter === null) return json(401, { error: 'invalid_code' })
    const recoveryCodes: string[] = []
    const inserts = []
    for (let i = 0; i < 10; i++) {
      const recovery = randomToken(9).toUpperCase()
      recoveryCodes.push(recovery)
      inserts.push(env.DB.prepare('INSERT INTO platform_auth_recovery_codes(id,user_id,code_hash) VALUES(?,?,?)')
        .bind(crypto.randomUUID(), user.id, await sha256Hex(recovery)))
    }
    await env.DB.batch(inserts)
    const session = await createSession(env, user.id, request)
    return json(200, { authenticated: true, recovery_codes: recoveryCodes, expires_in: SESSION_SECONDS }, { 'Set-Cookie': session.cookie })
  }
  return completeLogin(env, user.id, request)
}

async function logout(request: Request, env: Env): Promise<Response> {
  const token = readCookie(request, 'platformcore_session')
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const hash = await sha256Hex(token)
    const now = new Date().toISOString()
    const primaryIdentity = await identityForToken(env, token)
    if (primaryIdentity) {
      await env.DB.prepare('UPDATE platform_auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL')
        .bind(now, hash).run()
    } else if (env.DEMO_DB) {
      await env.DEMO_DB.prepare('UPDATE platform_auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL')
        .bind(now, hash).run()
    }
  }
  return json(200, { signed_out: true }, { 'Set-Cookie': clearSessionCookie(request) })
}

export async function handleNativeAuth(request: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith('/auth/')) return null
  if (path === '/auth/session' && request.method === 'GET') {
    const identity = await authenticateNativeSession(request, env)
    if (identity) {
      let userEnv = env
      let user = await env.DB.prepare(
        `SELECT pu.id,pu.email,c.login_id,
          EXISTS(SELECT 1 FROM platform_admin_accounts aa WHERE aa.user_id=pu.id AND aa.status='active') AS is_admin,
          (SELECT tm.role FROM tenant_memberships tm WHERE tm.user_id=pu.id AND tm.status='active' ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END LIMIT 1) AS tenant_role
         FROM platform_users pu JOIN platform_user_credentials c ON c.user_id=pu.id WHERE pu.id=?`,
      ).bind(identity.subject).first<{ id: string; email: string | null; login_id: string; is_admin: number; tenant_role: string | null }>()
      if (!user && env.DEMO_DB) {
        userEnv = { ...env, DB: env.DEMO_DB }
        user = await userEnv.DB.prepare(
          `SELECT pu.id,pu.email,c.login_id,
            EXISTS(SELECT 1 FROM platform_admin_accounts aa WHERE aa.user_id=pu.id AND aa.status='active') AS is_admin,
            (SELECT tm.role FROM tenant_memberships tm WHERE tm.user_id=pu.id AND tm.status='active' ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END LIMIT 1) AS tenant_role
           FROM platform_users pu JOIN platform_user_credentials c ON c.user_id=pu.id WHERE pu.id=?`,
        ).bind(identity.subject).first<{ id: string; email: string | null; login_id: string; is_admin: number; tenant_role: string | null }>()
      }
      if (!user) return json(401, { authenticated: false })
      const memberships = await userEnv.DB.prepare(
        `SELECT tm.tenant_id,t.name AS tenant_name,t.slug AS tenant_slug,tm.role AS membership_role,
          rs.id AS staff_id,rs.role AS staff_role,rs.display_name
         FROM tenant_memberships tm JOIN tenants t ON t.id=tm.tenant_id
         LEFT JOIN restaurant_staff rs ON rs.tenant_id=tm.tenant_id AND rs.user_id=tm.user_id AND rs.active=1
         WHERE tm.user_id=? AND tm.status='active'
         ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END`,
      ).bind(identity.subject).all<Record<string, unknown>>()
      return json(200, {
        authenticated: true,
        user: {
          id: user.id, email: user.email, login_id: user.login_id,
          is_admin: Boolean(user.is_admin), tenant_role: user.tenant_role,
          memberships: memberships.results,
        },
      })
    }
    const admins = await env.DB.prepare('SELECT COUNT(*) AS count FROM platform_admin_accounts').first<{ count: number }>()
    return json(200, {
      authenticated: false,
      bootstrap_available: Number(admins?.count || 0) === 0 && Boolean(env.AUTH_BOOTSTRAP_SECRET),
      encryption_ready: Boolean(env.AUTH_ENCRYPTION_KEY),
    })
  }
  if (!['POST'].includes(request.method)) return json(405, { error: 'method_not_allowed' })
  if (!validOrigin(request)) return json(403, { error: 'origin_not_allowed' })
  if (path === '/auth/bootstrap-admin') return bootstrapAdmin(request, env)
  if (path === '/auth/login') return login(request, env)
  if (path === '/auth/totp/enroll/verify') return verifyMfa(request, env, true)
  if (path === '/auth/totp/verify') return verifyMfa(request, env, false)
  if (path === '/auth/logout') return logout(request, env)
  return json(404, { error: 'not_found' })
}
