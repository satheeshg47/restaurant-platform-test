import { authenticateAdmin } from './auth.ts'
import type { Env, Identity } from './types.ts'
import { hashPassword, randomToken, sha256Hex } from './native-auth-crypto.ts'
import { sendPlatformEmail } from './platform-email.ts'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await request.text()
  if (raw.length > 8192) return null
  try { const value: unknown = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
  catch { return null }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char))
}

async function issueReset(env: Env, request: Request, user: { id: string; email: string; display_name?: string | null }, actor?: Identity): Promise<boolean> {
  const token = randomToken(32)
  const tokenHash = await sha256Hex(token)
  const now = new Date()
  const expires = new Date(now.getTime() + 15 * 60 * 1000).toISOString()
  const id = crypto.randomUUID()
  await env.DB.prepare(
    'INSERT INTO platform_password_reset_tokens(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)',
  ).bind(id, user.id, tokenHash, expires).run()
  const base = (env.APP_PUBLIC_URL || new URL(request.url).origin).replace(/\/$/, '')
  const link = base + '/owner/reset-password?token=' + encodeURIComponent(token)
  const greeting = user.display_name ? 'Hello ' + user.display_name + ',' : 'Hello,'
  const sent = await sendPlatformEmail(env, {
    to: user.email,
    subject: 'Reset your Platform Core password',
    text: greeting + '\n\nUse this one-time link to reset your password. It expires in 15 minutes:\n' + link + '\n\nIf you did not request this, you can ignore this email.',
    html: '<p>' + escapeHtml(greeting) + '</p><p>Use this one-time link to reset your password. It expires in 15 minutes.</p><p><a href="' + escapeHtml(link) + '">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>',
  })
  if (actor) {
    await env.DB.prepare(
      "INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata) VALUES(?,?,'owner.password_reset.initiated','platform_user',?,?)",
    ).bind(actor.issuer, actor.subject, user.id, JSON.stringify({ delivery: sent ? 'sent' : 'failed' })).run()
  }
  return sent
}

export async function handleAccountRecovery(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === '/auth/password-reset/request' && request.method === 'POST') {
    const payload = await body(request)
    const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : ''
    if (!EMAIL.test(email) || email.length > 320) return json(200, { ok: true })
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
    const digest = await sha256Hex(email)
    const nowRate = new Date().toISOString()
    const rate = await env.DB.prepare(
      `INSERT INTO platform_auth_rate_limits(bucket_key,window_started_at,attempt_count,updated_at)
       VALUES(?,?,1,?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         attempt_count=CASE WHEN platform_auth_rate_limits.window_started_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes') THEN 1 ELSE MIN(platform_auth_rate_limits.attempt_count+1,1000) END,
         window_started_at=CASE WHEN platform_auth_rate_limits.window_started_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes') THEN excluded.window_started_at ELSE platform_auth_rate_limits.window_started_at END,
         updated_at=excluded.updated_at
       RETURNING attempt_count`,
    ).bind('password-reset:' + digest + ':' + ip, nowRate, nowRate).first<{ attempt_count: number }>()
    if (Number(rate?.attempt_count || 0) > 3) return json(200, { ok: true })
    const user = await env.DB.prepare(
      `SELECT pu.id,pu.email FROM platform_users pu
       JOIN platform_user_credentials c ON c.user_id=pu.id
       WHERE lower(pu.email)=? AND c.credential_status='active'
         AND EXISTS(SELECT 1 FROM tenant_memberships tm WHERE tm.user_id=pu.id AND tm.role='owner' AND tm.status='active')
       LIMIT 1`,
    ).bind(email).first<{ id: string; email: string | null }>()
    if (user?.email) await issueReset(env, request, { id: user.id, email: user.email })
    return json(200, { ok: true })
  }

  if (path === '/auth/password-reset/complete' && request.method === 'POST') {
    const payload = await body(request)
    const token = typeof payload?.token === 'string' ? payload.token : ''
    const password = typeof payload?.password === 'string' ? payload.password : ''
    if (!TOKEN.test(token) || password.length < 12 || password.length > 256) return json(400, { error: 'invalid_reset_request' })
    const tokenHash = await sha256Hex(token)
    const tokenRow = await env.DB.prepare(
      'SELECT id,user_id FROM platform_password_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?',
    ).bind(tokenHash, new Date().toISOString()).first<{ id: string; user_id: string }>()
    if (!tokenRow) return json(400, { error: 'invalid_or_expired_reset_link' })
    const passwordHash = await hashPassword(password)
    const now = new Date().toISOString()
    const results = await env.DB.batch([
      env.DB.prepare('UPDATE platform_password_reset_tokens SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>? RETURNING user_id').bind(now, tokenRow.id, now),
      env.DB.prepare('UPDATE platform_user_credentials SET password_hash=?,password_changed_at=?,updated_at=? WHERE user_id=? AND EXISTS(SELECT 1 FROM platform_password_reset_tokens WHERE id=? AND used_at=? AND user_id=?)').bind(passwordHash, now, now, tokenRow.user_id, tokenRow.id, now, tokenRow.user_id),
      env.DB.prepare('UPDATE platform_auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM platform_password_reset_tokens WHERE id=? AND used_at=?) AND EXISTS(SELECT 1 FROM platform_user_credentials WHERE user_id=? AND password_changed_at=?)').bind(now, tokenRow.user_id, tokenRow.id, now, tokenRow.user_id, now),
      env.DB.prepare("UPDATE platform_password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL AND EXISTS(SELECT 1 FROM platform_user_credentials WHERE user_id=? AND password_changed_at=?)").bind(now, tokenRow.user_id, tokenRow.user_id, now),
      env.DB.prepare("INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata) SELECT 'system','password-reset','owner.password_reset.completed','platform_user',?,'{}' WHERE EXISTS(SELECT 1 FROM platform_user_credentials WHERE user_id=? AND password_changed_at=?)").bind(tokenRow.user_id, tokenRow.user_id, now),
    ])
    if (!results[0]?.results?.length || Number(results[1]?.meta?.changes || 0) !== 1) return json(400, { error: 'invalid_or_expired_reset_link' })
    const user = await env.DB.prepare('SELECT email FROM platform_users WHERE id=?').bind(tokenRow.user_id).first<{ email: string | null }>()
    if (user?.email) await sendPlatformEmail(env, {
      to: user.email, subject: 'Your Platform Core password was changed',
      text: 'Your Platform Core password was changed successfully. If you did not make this change, contact your platform administrator immediately.',
      html: '<p>Your Platform Core password was changed successfully.</p><p>If you did not make this change, contact your platform administrator immediately.</p>',
    })
    return json(200, { password_reset: true, sessions_revoked: true })
  }

  const adminMatch = path.match(/^\/admin\/users\/([0-9a-f-]{36})\/password-reset$/i)
  if (adminMatch && request.method === 'POST') {
    let actor: Identity
    try { actor = await authenticateAdmin(request, env) }
    catch { return json(401, { error: 'unauthorized' }) }
    const user = await env.DB.prepare(
      `SELECT pu.id,pu.email FROM platform_users pu JOIN tenant_memberships tm ON tm.user_id=pu.id
       WHERE pu.id=? AND tm.role='owner' AND tm.status='active' LIMIT 1`,
    ).bind(adminMatch[1]).first<{ id: string; email: string | null }>()
    if (!user?.email) return json(404, { error: 'owner_not_found' })
    const sent = await issueReset(env, request, { id: user.id, email: user.email }, actor)
    return sent ? json(200, { reset_link_sent: true }) : json(503, { error: 'email_delivery_not_configured' })
  }
  return null
}
