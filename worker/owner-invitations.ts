import { authenticateAdmin, authenticateIdentity, authenticateVerifiedEmail, authStatus } from './auth.ts'
import type { Env, Identity, D1Result } from './types.ts'
import { hashPassword } from './native-auth-crypto.ts'
import { sendPlatformEmail } from './platform-email.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('Content-Length') || 0)
  if (declared > 8192) throw Object.assign(new Error('payload_too_large'), { status: 413 })
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > 8192) throw Object.assign(new Error('payload_too_large'), { status: 413 })
  try {
    const body: unknown = JSON.parse(raw)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid')
    return body as Record<string, unknown>
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 })
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function safeAuthResponse(error: unknown, isAccept: boolean): Response {
  const status = authStatus(error, 401)
  return json(status, {
    error: status === 503 ? (isAccept ? 'owner_auth_not_configured' : 'admin_auth_not_configured') : status === 403 ? 'forbidden' : 'unauthorized',
  })
}

export async function handleOwnerInvitations(request: Request, env: Env, path: string): Promise<Response> {
  const isAdminList = path === '/admin/owner-invitations'
  const revokeMatch = path.match(/^\/admin\/owner-invitations\/([^/]+)\/revoke$/)
  const isAccept = path === '/owner/invitations/accept'
  if (!isAdminList && !revokeMatch && !isAccept) return json(404, { error: 'not_found' })

  let identity: Identity | null = null
  let verifiedIdentity: Identity | null = null
  if (isAccept) {
    const hasSession = request.headers.has('Authorization') ||
      request.headers.has('X-OIDC-ID-Token') ||
      (request.headers.get('Cookie') || '').includes('platformcore_session=')
    if (hasSession) {
      try { identity = await authenticateIdentity(request, env) }
      catch (error) { return safeAuthResponse(error, true) }
      if (identity.issuer === 'native') {
        verifiedIdentity = { ...identity, emailVerified: true }
      } else {
        try { verifiedIdentity = await authenticateVerifiedEmail(request, env) }
        catch (error) {
          const status = authStatus(error, 401)
          return json(status, { error: status === 503 ? 'verified_email_auth_not_configured' : status === 403 ? 'verified_email_required' : 'invalid_id_token' })
        }
        if (verifiedIdentity.issuer !== identity.issuer || verifiedIdentity.subject !== identity.subject) {
          return json(401, { error: 'identity_token_subject_mismatch' })
        }
      }
    }
  } else {
    try { identity = await authenticateAdmin(request, env) }
    catch (error) { return safeAuthResponse(error, false) }
  }
  if (!isAccept && !identity) return json(401, { error: 'unauthorized' })

  if (isAdminList && request.method === 'GET') {
    try {
      const result = await env.DB.prepare(
        `SELECT i.id,i.tenant_id,t.name AS tenant_name,t.slug AS tenant_slug,
          i.email,i.status,i.created_at,i.expires_at
         FROM platform_owner_invitations i JOIN tenants t ON t.id=i.tenant_id
         ORDER BY i.created_at DESC LIMIT 500`,
      ).all()
      return json(200, { invitations: result.results })
    } catch { return json(500, { error: 'owner_invitation_list_failed' }) }
  }

  if (revokeMatch) {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' })
    const invitationId = revokeMatch[1]
    if (!UUID.test(invitationId)) return json(400, { error: 'invalid_invitation_id' })
    try {
      const invitation = await env.DB.prepare(
        'SELECT id,tenant_id,email,status FROM platform_owner_invitations WHERE id=?',
      ).bind(invitationId).first<{ id: string; tenant_id: string; email: string; status: string }>()
      if (!invitation) return json(404, { error: 'invitation_not_found' })
      if (invitation.status !== 'pending') return json(409, { error: 'invitation_not_pending' })
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE platform_owner_invitations SET status='revoked' WHERE id=? AND status='pending'",
        ).bind(invitationId),
        env.DB.prepare(
          `INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata)
           SELECT ?,?,'owner.invitation.revoked','owner_invitation',?,?
           WHERE EXISTS (SELECT 1 FROM platform_owner_invitations WHERE id=? AND status='revoked')
             AND NOT EXISTS (SELECT 1 FROM platform_audit_events WHERE action='owner.invitation.revoked' AND resource_id=?)`,
        ).bind(identity!.issuer, identity!.subject, invitationId, JSON.stringify({ tenant_id: invitation.tenant_id, email: invitation.email }), invitationId, invitationId),
      ])
      const after = await env.DB.prepare('SELECT status FROM platform_owner_invitations WHERE id=?').bind(invitationId).first<{ status: string }>()
      return after?.status === 'revoked'
        ? json(200, { revoked: true, id: invitationId })
        : json(409, { error: 'invitation_not_pending' })
    } catch { return json(500, { error: 'owner_invitation_revoke_failed' }) }
  }

  if (isAdminList) {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' })
    let body: Record<string, unknown>
    try { body = await readBody(request) }
    catch (error) { const status = authStatus(error, 400); return json(status, { error: status === 413 ? 'payload_too_large' : 'invalid_json' }) }
    const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id : ''
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!UUID.test(tenantId) || email.length > 320 || !EMAIL.test(email)) return json(400, { error: 'invalid_invitation' })

    const tokenBytes = crypto.getRandomValues(new Uint8Array(32))
    const token = base64url(tokenBytes)
    const tokenHash = await hashToken(token)
    const id = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    try {
      const tenant = await env.DB.prepare("SELECT id FROM tenants WHERE id=? AND status='active'").bind(tenantId).first()
      if (!tenant) return json(404, { error: 'tenant_not_found' })
      const owner = await env.DB.prepare(
        "SELECT 1 AS found FROM tenant_memberships WHERE tenant_id=? AND role='owner' AND status='active' LIMIT 1",
      ).bind(tenantId).first()
      if (owner) return json(409, { error: 'active_owner_already_exists' })

      await env.DB.prepare(
        "UPDATE platform_owner_invitations SET status='expired' WHERE tenant_id=? AND email=? AND status='pending' AND expires_at<=?",
      ).bind(tenantId, email, new Date().toISOString()).run()

      const statements = [
        env.DB.prepare(
          `INSERT INTO platform_owner_invitations
            (id,tenant_id,email,token_hash,created_by_issuer,created_by_subject,expires_at)
           SELECT ?,?,?,?,?,?,?
           WHERE EXISTS (SELECT 1 FROM tenants WHERE id=? AND status='active')
             AND NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id=? AND role='owner' AND status='active')
             AND NOT EXISTS (SELECT 1 FROM platform_owner_invitations WHERE tenant_id=? AND email=? AND status='pending')
           RETURNING id,tenant_id,email,expires_at`,
        ).bind(id, tenantId, email, tokenHash, identity!.issuer, identity!.subject, expiresAt, tenantId, tenantId, tenantId, email),
        env.DB.prepare(
          `INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata)
           SELECT ?,?,'owner.invitation.created','owner_invitation',?,?
           WHERE EXISTS (SELECT 1 FROM platform_owner_invitations WHERE id=?)`,
        ).bind(identity!.issuer, identity!.subject, id, JSON.stringify({ tenant_id: tenantId, email }), id),
      ]
      const results = await env.DB.batch<D1Result<Record<string, unknown>>>(statements)
      const row = results[0]?.results?.[0]
      if (!row) {
        const active = await env.DB.prepare(
          "SELECT 1 FROM tenant_memberships WHERE tenant_id=? AND role='owner' AND status='active' LIMIT 1",
        ).bind(tenantId).first()
        if (active) return json(409, { error: 'active_owner_already_exists' })
        return json(409, { error: 'pending_invitation_exists' })
      }
      const base = (env.APP_PUBLIC_URL || new URL(request.url).origin).replace(/\\/$/, '')
      const inviteUrl = base + '/owner/invitations/accept?token=' + encodeURIComponent(token)
      const tenantName = await env.DB.prepare('SELECT name FROM tenants WHERE id=?').bind(tenantId).first<{ name: string }>()
      const safeName = (tenantName?.name || 'your restaurant').replace(/[&<>\"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[char] || char))
      const delivered = await sendPlatformEmail(env, {
        to: email,
        subject: 'You are invited to manage ' + (tenantName?.name || 'a restaurant'),
        text: 'You have been invited to become the owner of ' + (tenantName?.name || 'a restaurant') + '. Open this one-time link within 48 hours to create your password and activate your account:\\n' + inviteUrl,
        html: '<p>You have been invited to become the owner of ' + safeName + '.</p><p><a href="' + inviteUrl.replace(/&/g, '&amp;').replace(/\"/g, '&quot;') + '">Accept owner invitation</a></p><p>This one-time link expires in 48 hours.</p>',
      })
      return json(201, {
        invitation: { id: row.id, tenant_id: row.tenant_id, email: row.email, expires_at: row.expires_at },
        ...(delivered ? {} : { token }),
        delivery: delivered ? 'email_sent' : 'manual_link_required',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      return json(/UNIQUE|constraint/i.test(message) ? 409 : 500, {
        error: /UNIQUE|constraint/i.test(message) ? 'pending_invitation_exists' : 'owner_invitation_create_failed',
      })
    }
  }

  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  let body: Record<string, unknown>
  try { body = await readBody(request) }
  catch (error) { const status = authStatus(error, 400); return json(status, { error: status === 413 ? 'payload_too_large' : 'invalid_json' }) }
  const token = typeof body.token === 'string' ? body.token : ''
  if (!TOKEN.test(token)) return json(400, { error: 'invalid_invitation_token' })

  const tokenHash = await hashToken(token)
  try {
    const invitation = await env.DB.prepare(
      `SELECT i.id,i.tenant_id,i.email,i.status,i.expires_at,t.name AS tenant_name,t.status AS tenant_status
       FROM platform_owner_invitations i JOIN tenants t ON t.id=i.tenant_id
       WHERE i.token_hash=?`,
    ).bind(tokenHash).first<{ id: string; tenant_id: string; email: string; status: string; expires_at: string; tenant_name: string; tenant_status: string }>()
    if (!invitation || invitation.status !== 'pending') return json(404, { error: 'invitation_not_found' })
    if (invitation.tenant_status !== 'active') return json(409, { error: 'tenant_not_active' })
    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      await env.DB.prepare("UPDATE platform_owner_invitations SET status='expired' WHERE id=? AND status='pending'").bind(invitation.id).run()
      return json(410, { error: 'invitation_expired' })
    }

    let acceptedIdentity = identity
    let email = ''
    let newNativeUser = false
    let newLoginId = ''
    let newPasswordHash = ''
    if (acceptedIdentity) {
      if (!verifiedIdentity?.email) return json(403, { error: 'verified_email_required' })
      email = verifiedIdentity.email.trim().toLowerCase()
      if (invitation.email !== email) return json(403, { error: 'invitation_email_mismatch' })
    } else {
      const password = typeof body.password === 'string' ? body.password : ''
      if (password.length < 12 || password.length > 256) return json(400, { error: 'invalid_password_length' })
      const existingNative = await env.DB.prepare(
        "SELECT 1 AS found FROM platform_users WHERE auth_provider='native' AND lower(email)=? LIMIT 1",
      ).bind(invitation.email.toLowerCase()).first()
      if (existingNative) return json(409, { error: 'native_account_exists_sign_in' })
      acceptedIdentity = {
        issuer: 'native',
        subject: crypto.randomUUID(),
        email: invitation.email,
        emailVerified: true,
      }
      email = invitation.email.toLowerCase()
      newNativeUser = true
      newLoginId = 'owner-' + crypto.randomUUID().replace(/-/g, '')
      newPasswordHash = await hashPassword(password)
    }

    if (!acceptedIdentity) return json(401, { error: 'unauthorized' })
    const activeOwner = await env.DB.prepare(
      "SELECT 1 AS found FROM tenant_memberships WHERE tenant_id=? AND role='owner' AND status='active' LIMIT 1",
    ).bind(invitation.tenant_id).first()
    if (activeOwner) return json(409, { error: 'active_owner_already_exists' })

    const metadata = JSON.stringify({ invitation_id: invitation.id, account_created: newNativeUser })
    const userInsert = newNativeUser
      ? env.DB.prepare(
          `INSERT INTO platform_users(id,auth_provider,auth_subject,email)
           SELECT ?,'native',?,?
           WHERE EXISTS (SELECT 1 FROM platform_owner_invitations WHERE id=? AND status='pending' AND expires_at>?)
             AND NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id=? AND role='owner' AND status='active')`,
        ).bind(acceptedIdentity.subject, acceptedIdentity.subject, email, invitation.id, new Date().toISOString(), invitation.tenant_id)
      : env.DB.prepare(
          `INSERT INTO platform_users(auth_provider,auth_subject,email)
           SELECT ?,?,?
           WHERE EXISTS (SELECT 1 FROM platform_owner_invitations WHERE id=? AND status='pending' AND expires_at>?)
             AND NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id=? AND role='owner' AND status='active')
           ON CONFLICT(auth_provider,auth_subject) DO UPDATE SET email=excluded.email`,
        ).bind(acceptedIdentity.issuer, acceptedIdentity.subject, email, invitation.id, new Date().toISOString(), invitation.tenant_id)

    const statements = [userInsert]
    if (newNativeUser) {
      statements.push(env.DB.prepare(
        'INSERT INTO platform_user_credentials(user_id,login_id,login_id_normalized,password_hash) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM platform_users WHERE id=?)',
      ).bind(acceptedIdentity.subject, newLoginId, newLoginId.toLowerCase(), newPasswordHash, acceptedIdentity.subject))
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO tenant_memberships(tenant_id,user_id,role,status)
         SELECT i.tenant_id,pu.id,'owner','active'
         FROM platform_owner_invitations i JOIN platform_users pu
           ON pu.auth_provider=? AND pu.auth_subject=?
         WHERE i.id=? AND i.status='pending' AND i.expires_at>?
           AND i.email=? AND i.tenant_id=?
           AND NOT EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.tenant_id=i.tenant_id AND tm.role='owner' AND tm.status='active')
         ON CONFLICT(tenant_id,user_id) DO UPDATE SET role='owner',status='active'`,
      ).bind(acceptedIdentity.issuer, acceptedIdentity.subject, invitation.id, new Date().toISOString(), email, invitation.tenant_id),
      env.DB.prepare(
        `UPDATE platform_owner_invitations
         SET status='accepted',accepted_by_issuer=?,accepted_by_subject=?,accepted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=? AND status='pending'
           AND EXISTS (
             SELECT 1 FROM tenant_memberships tm JOIN platform_users pu ON pu.id=tm.user_id
             WHERE tm.tenant_id=? AND tm.role='owner' AND tm.status='active'
               AND pu.auth_provider=? AND pu.auth_subject=?
           )`,
      ).bind(acceptedIdentity.issuer, acceptedIdentity.subject, invitation.id, invitation.tenant_id, acceptedIdentity.issuer, acceptedIdentity.subject),
      env.DB.prepare(
        `INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata)
         SELECT ?,?,'owner.invitation.accepted','tenant',?,?
         WHERE EXISTS (SELECT 1 FROM platform_owner_invitations WHERE id=? AND status='accepted' AND accepted_by_issuer=? AND accepted_by_subject=?)
           AND NOT EXISTS (SELECT 1 FROM platform_audit_events WHERE action='owner.invitation.accepted' AND resource_id=? AND actor_issuer=? AND actor_subject=?)`,
      ).bind(acceptedIdentity.issuer, acceptedIdentity.subject, invitation.tenant_id, metadata, invitation.id, acceptedIdentity.issuer, acceptedIdentity.subject, invitation.tenant_id, acceptedIdentity.issuer, acceptedIdentity.subject),
    )
    await env.DB.batch(statements)

    const after = await env.DB.prepare(
      'SELECT status FROM platform_owner_invitations WHERE id=?',
    ).bind(invitation.id).first<{ status: string }>()
    if (after?.status !== 'accepted') {
      const owner = await env.DB.prepare(
        "SELECT 1 FROM tenant_memberships WHERE tenant_id=? AND role='owner' AND status='active' LIMIT 1",
      ).bind(invitation.tenant_id).first()
      return owner ? json(409, { error: 'active_owner_already_exists' }) : json(409, { error: 'invitation_not_pending' })
    }
    return json(200, {
      accepted: true,
      account_created: newNativeUser,
      tenant: { id: invitation.tenant_id, name: invitation.tenant_name },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/UNIQUE|constraint/i.test(message)) return json(409, { error: /login_id/i.test(message) ? 'login_id_unavailable' : 'invitation_not_pending' })
    return json(500, { error: 'owner_invitation_accept_failed' })
  }
}
