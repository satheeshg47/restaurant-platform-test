import { authenticateAdmin, authenticateIdentity, authenticateVerifiedEmail, authStatus } from './auth.ts'
import type { Env, Identity } from './types.ts'
import { hashPassword, randomToken, sha256Hex } from './native-auth-crypto.ts'
import { sendPlatformEmail } from './platform-email.ts'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
}
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await request.text()
  if (raw.length > 8192) return null
  try { const value: unknown = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
  catch { return null }
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char))
}

export async function handleOwnerTransfers(request: Request, env: Env, path: string): Promise<Response | null> {
  const adminMatch = path.match(/^\/admin\/tenants\/([0-9a-f-]{36})\/owner-transfer$/i)
  if (adminMatch && request.method === 'POST') {
    let actor: Identity
    try { actor = await authenticateAdmin(request, env) }
    catch (error) { const status = authStatus(error, 401); return json(status, { error: status === 403 ? 'forbidden' : 'unauthorized' }) }
    const body = await readBody(request)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    const transferType = body?.transfer_type === 'admin_controlled' ? 'admin_controlled' : 'standard'
    if (!EMAIL.test(email) || email.length > 320 || reason.length < 3 || reason.length > 1000) return json(400, { error: 'invalid_transfer_request' })
    const tenant = await env.DB.prepare("SELECT id,name,status FROM tenants WHERE id=? AND status='active'").bind(adminMatch[1]).first<{id:string;name:string;status:string}>()
    if (!tenant) return json(404, { error: 'tenant_not_found' })
    const current = await env.DB.prepare(
      "SELECT pu.id,pu.email FROM tenant_memberships tm JOIN platform_users pu ON pu.id=tm.user_id WHERE tm.tenant_id=? AND tm.role='owner' AND tm.status='active' LIMIT 1",
    ).bind(tenant.id).first<{id:string;email:string|null}>()
    if (!current) return json(409, { error: 'active_owner_not_found' })
    if (current.email?.toLowerCase() === email) return json(400, { error: 'new_owner_must_be_different' })
    const existing = await env.DB.prepare("SELECT id FROM owner_transfer_invitations WHERE tenant_id=? AND status='pending'").bind(tenant.id).first()
    if (existing) return json(409, { error: 'transfer_already_pending' })
    const token = randomToken(32)
    const approvalToken = transferType === 'standard' ? randomToken(32) : ''
    const id = crypto.randomUUID()
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    await env.DB.prepare(
      `INSERT INTO owner_transfer_invitations(id,tenant_id,from_user_id,target_email,token_hash,outgoing_approval_token_hash,reason,transfer_type,initiated_by_issuer,initiated_by_subject,expires_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, tenant.id, current.id, email, await sha256Hex(token), approvalToken ? await sha256Hex(approvalToken) : null, reason, transferType, actor.issuer, actor.subject, expires).run()
    const base = (env.APP_PUBLIC_URL || new URL(request.url).origin).replace(/\/$/, '')
    const link = base + '/owner/transfers/accept?token=' + encodeURIComponent(token)
    const safeName = escapeHtml(tenant.name)
    const sent = await sendPlatformEmail(env, {
      to: email,
      subject: 'Accept ownership of ' + tenant.name,
      text: 'You have been invited to become the owner of ' + tenant.name + '. Accept this transfer within 7 days: ' + link,
      html: '<p>You have been invited to become the owner of ' + safeName + '.</p><p><a href="' + escapeHtml(link) + '">Accept ownership transfer</a></p><p>This link expires in 7 days.</p>',
    })
    let approvalSent = true
    if (approvalToken && current.email) {
      const approvalLink = base + '/owner/transfers/approve?token=' + encodeURIComponent(approvalToken)
      approvalSent = await sendPlatformEmail(env, {
        to: current.email,
        subject: 'Approve ownership transfer for ' + tenant.name,
        text: 'A transfer of ' + tenant.name + ' ownership has been requested. If you agree, approve it within 7 days: ' + approvalLink + '. If you do not agree, do not open the link; contact the platform administrator.',
        html: '<p>A transfer of ' + safeName + ' ownership has been requested.</p><p><a href="' + escapeHtml(approvalLink) + '">Approve ownership transfer</a></p><p>If you do not agree, do not approve this request. The link expires in 7 days.</p>',
      })
    } else if (approvalToken) {
      approvalSent = false
    }
    await env.DB.prepare(
      "INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata) VALUES(?,?,'owner.transfer.initiated','tenant',?,?)",
    ).bind(actor.issuer, actor.subject, tenant.id, JSON.stringify({ invitation_id: id, target_email: email, outgoing_owner_user_id: current.id, transfer_type: transferType, new_owner_email_delivery: sent ? 'sent' : 'failed', outgoing_owner_approval_delivery: approvalSent ? 'sent' : 'failed', reason })).run()
    const delivered = sent && approvalSent
    return json(201, {
      transfer: { id, tenant_id: tenant.id, tenant_name: tenant.name, target_email: email, outgoing_owner_email: current.email, expires_at: expires },
      delivery: delivered ? 'email_sent' : 'manual_link_required',
      ...(!sent ? { token } : {}),
      ...(approvalToken && !approvalSent ? { approval_token: approvalToken } : {}),
    })
  }

  if (path === '/owner/transfers/accept' && request.method === 'POST') {
    const body = await readBody(request)
    const token = typeof body?.token === 'string' ? body.token : ''
    if (!TOKEN.test(token)) return json(400, { error: 'invalid_transfer_token' })
    const invite = await env.DB.prepare(
      `SELECT i.id,i.tenant_id,i.from_user_id,i.target_email,i.reason,i.transfer_type,i.outgoing_approved_at,i.initiated_by_issuer,i.initiated_by_subject,i.status,i.expires_at,t.name AS tenant_name,t.status AS tenant_status
       FROM owner_transfer_invitations i JOIN tenants t ON t.id=i.tenant_id WHERE i.token_hash=?`,
    ).bind(await sha256Hex(token)).first<{id:string;tenant_id:string;from_user_id:string;target_email:string;reason:string;transfer_type:'standard'|'admin_controlled';outgoing_approved_at:string|null;initiated_by_issuer:string;initiated_by_subject:string;status:string;expires_at:string;tenant_name:string;tenant_status:string}>()
    if (!invite || invite.status !== 'pending') return json(404, { error: 'transfer_invitation_not_found' })
    if (invite.tenant_status !== 'active') return json(409, { error: 'tenant_not_active' })
    if (invite.transfer_type === 'standard' && !invite.outgoing_approved_at) return json(409, { error: 'outgoing_owner_approval_required' })
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      await env.DB.prepare("UPDATE owner_transfer_invitations SET status='expired' WHERE id=? AND status='pending'").bind(invite.id).run()
      return json(410, { error: 'transfer_invitation_expired' })
    }
    let identity: Identity | null = null
    let newNativeUser = false
    let newPasswordHash = ''
    let newLoginId = ''
    const hasSession = request.headers.has('Authorization') || request.headers.has('X-OIDC-ID-Token') || (request.headers.get('Cookie') || '').includes('platformcore_session=')
    if (hasSession) {
      try { identity = await authenticateIdentity(request, env) }
      catch (error) { const status = authStatus(error, 401); return json(status, { error: status === 403 ? 'forbidden' : 'unauthorized' }) }
      if (identity.issuer === 'native') {
        const verified = await env.DB.prepare("SELECT email FROM platform_users WHERE id=? AND auth_provider='native'").bind(identity.subject).first<{email:string|null}>()
        if (!verified?.email) return json(403, { error: 'verified_email_required' })
        identity = { ...identity, email: verified.email, emailVerified: true }
      } else {
        try { identity = await authenticateVerifiedEmail(request, env) }
        catch { return json(403, { error: 'verified_email_required' }) }
      }
      if (!identity.email || !identity.emailVerified || identity.email.toLowerCase() !== invite.target_email) return json(403, { error: 'transfer_email_mismatch' })
    } else {
      const password = typeof body?.password === 'string' ? body.password : ''
      if (password.length < 12 || password.length > 256) return json(400, { error: 'password_required' })
      const existing = await env.DB.prepare("SELECT id FROM platform_users WHERE auth_provider='native' AND lower(email)=?").bind(invite.target_email).first()
      if (existing) return json(409, { error: 'sign_in_to_existing_account' })
      if (!env.AUTH_ENCRYPTION_KEY) { /* Owner accounts do not require TOTP; encryption key is not needed. */ }
      const id = crypto.randomUUID()
      newLoginId = 'owner-' + crypto.randomUUID().replace(/-/g, '')
      newPasswordHash = await hashPassword(password)
      newNativeUser = true
      identity = { issuer: 'native', subject: id, email: invite.target_email, emailVerified: true }
    }
    const newUser = newNativeUser
      ? { id: identity!.subject, email: invite.target_email }
      : await env.DB.prepare('SELECT id,email FROM platform_users WHERE auth_provider=? AND auth_subject=?').bind(identity!.issuer, identity!.subject).first<{id:string;email:string|null}>()
    if (!newUser || newUser.id === invite.from_user_id) return json(409, { error: 'invalid_new_owner' })
    const now = new Date().toISOString()
    const historyId = crypto.randomUUID()
    try {
      const statements = []
      if (newNativeUser) {
        statements.push(env.DB.prepare(
          "INSERT INTO platform_users(id,auth_provider,auth_subject,email) SELECT ?,'native',?,? WHERE EXISTS(SELECT 1 FROM owner_transfer_invitations WHERE id=? AND status='pending' AND expires_at>?)",
        ).bind(newUser.id, newUser.id, invite.target_email, invite.id, now))
        statements.push(env.DB.prepare(
          'INSERT INTO platform_user_credentials(user_id,login_id,login_id_normalized,password_hash) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM platform_users WHERE id=?)',
        ).bind(newUser.id, newLoginId, newLoginId, newPasswordHash, newUser.id))
      }
      statements.push(env.DB.prepare("UPDATE tenant_memberships SET status='suspended' WHERE tenant_id=? AND user_id=? AND role='owner' AND status='active' AND EXISTS(SELECT 1 FROM owner_transfer_invitations WHERE id=? AND status='pending' AND expires_at>?)").bind(invite.tenant_id, invite.from_user_id, invite.id, now),
        env.DB.prepare("INSERT INTO tenant_memberships(tenant_id,user_id,role,status) SELECT ?,?,'owner','active' WHERE EXISTS(SELECT 1 FROM owner_transfer_invitations WHERE id=? AND status='pending' AND expires_at>?) AND NOT EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=? AND role='owner' AND status='active') ON CONFLICT(tenant_id,user_id) DO UPDATE SET role='owner',status='active'").bind(invite.tenant_id, newUser.id, invite.id, now, invite.tenant_id),
        env.DB.prepare("UPDATE owner_transfer_invitations SET status='accepted',accepted_by_user_id=?,accepted_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=? AND user_id=? AND role='owner' AND status='active')").bind(newUser.id, now, invite.id, invite.tenant_id, newUser.id),
        env.DB.prepare('INSERT INTO ownership_transfer_history(id,tenant_id,previous_owner_user_id,new_owner_user_id,initiated_by_issuer,initiated_by_subject,reason,transfer_type) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM owner_transfer_invitations WHERE id=? AND status=\'accepted\')').bind(historyId, invite.tenant_id, invite.from_user_id, newUser.id, invite.initiated_by_issuer, invite.initiated_by_subject, invite.reason, invite.transfer_type, invite.id),
        env.DB.prepare('UPDATE platform_auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM owner_transfer_invitations WHERE id=? AND status=\'accepted\')').bind(now, invite.from_user_id, invite.id),
        env.DB.prepare("INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata) SELECT ?,?,'owner.transfer.completed','tenant',?,? WHERE EXISTS(SELECT 1 FROM owner_transfer_invitations WHERE id=? AND status='accepted')").bind(identity.issuer, identity.subject, invite.tenant_id, JSON.stringify({ previous_owner_user_id: invite.from_user_id, new_owner_user_id: newUser.id, transfer_invitation_id: invite.id, reason: invite.reason }), invite.id),
      ])
      const accepted = await env.DB.prepare("SELECT status FROM owner_transfer_invitations WHERE id=?").bind(invite.id).first<{status:string}>()
      if (accepted?.status !== 'accepted') return json(409, { error: 'transfer_could_not_be_completed' })
      const previous = await env.DB.prepare('SELECT email FROM platform_users WHERE id=?').bind(invite.from_user_id).first<{email:string|null}>()
      if (previous?.email) await sendPlatformEmail(env, { to: previous.email, subject: 'Restaurant ownership transferred', text: 'Ownership of ' + invite.tenant_name + ' has been transferred to a new owner. Your access to this restaurant has been revoked.', html: '<p>Ownership of ' + escapeHtml(invite.tenant_name) + ' has been transferred. Your access to this restaurant has been revoked.</p>' })
      if (newUser.email) await sendPlatformEmail(env, { to: newUser.email, subject: 'You are now the owner of ' + invite.tenant_name, text: 'You are now the owner of ' + invite.tenant_name + '. Your restaurant data and history remain with the business.', html: '<p>You are now the owner of ' + escapeHtml(invite.tenant_name) + '. Your restaurant data and history remain with the business.</p>' })
      return json(200, { transferred: true, tenant: { id: invite.tenant_id, name: invite.tenant_name }, previous_owner_access_revoked: true })
    } catch {
      return json(409, { error: 'transfer_could_not_be_completed' })
    }
  }
  return null
}
