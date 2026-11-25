import { authenticateIdentity } from './auth.ts'
import { hashPassword } from './native-auth-crypto.ts'
import type { Env, Identity } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOGIN_ID = /^[A-Za-z0-9._-]{3,64}$/
const STAFF_ROLES = new Set(['cook', 'waiter', 'manager'])

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('Content-Length') || 0)
  if (declared > 8192) return null
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > 8192) return null
  try {
    const body: unknown = JSON.parse(raw)
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch { return null }
}

async function requireOwner(env: Env, identity: Identity, tenantId: string): Promise<void> {
  const membership = await env.DB.prepare(
    "SELECT 1 AS allowed FROM tenant_memberships WHERE tenant_id=? AND user_id=(SELECT id FROM platform_users WHERE auth_provider=? AND auth_subject=?) AND status='active' AND role IN ('owner','admin') LIMIT 1",
  ).bind(tenantId, identity.issuer, identity.subject).first()
  if (!membership) throw Object.assign(new Error('owner_access_required'), { status: 403 })
}

function errorResponse(error: unknown): Response {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500
  const code = error instanceof Error && status < 500 ? error.message : 'owner_staff_request_failed'
  return json(status, { error: code })
}

export async function handleOwnerStaff(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== '/owner/staff' && !path.startsWith('/owner/staff/')) return null
  if (!['GET', 'POST', 'PATCH'].includes(request.method)) return json(405, { error: 'method_not_allowed' })
  let identity: Identity
  try { identity = await authenticateIdentity(request, env) }
  catch { return json(401, { error: 'unauthorized' }) }

  const parts = path.split('/').filter(Boolean)
  const staffId = parts[2] || ''
  const passwordRoute = parts.length === 4 && parts[3] === 'password'
  if (parts.length > 4 || (staffId && !UUID.test(staffId))) return json(404, { error: 'staff_not_found' })

  const url = new URL(request.url)
  let body: Record<string, unknown> = {}
  if (request.method !== 'GET') {
    body = await readBody(request) || {}
    if (!Object.keys(body).length) return json(400, { error: 'invalid_request' })
  }
  const tenantId = request.method === 'GET'
    ? url.searchParams.get('tenant_id') || ''
    : typeof body.tenant_id === 'string' ? body.tenant_id : ''
  if (!UUID.test(tenantId)) return json(400, { error: 'invalid_tenant_id' })

  const demoTenant = env.DEMO_DB
    ? await env.DEMO_DB.prepare("SELECT id FROM tenants WHERE id=? AND slug='platform-demo-restaurant'").bind(tenantId).first()
    : null
  const dataEnv: Env = demoTenant ? { ...env, DB: env.DEMO_DB! } : env

  try {
    await requireOwner(dataEnv, identity, tenantId)
    if (request.method === 'GET') {
      if (staffId) return json(404, { error: 'staff_not_found' })
      const result = await dataEnv.DB.prepare(
        `SELECT rs.id AS staff_id,rs.user_id,rs.username,rs.display_name,rs.role,rs.active,rs.created_at,rs.last_login_at,
          c.login_id
         FROM restaurant_staff rs
         JOIN platform_users pu ON pu.id=rs.user_id
         JOIN platform_user_credentials c ON c.user_id=pu.id
         WHERE rs.tenant_id=? AND rs.user_id IS NOT NULL
         ORDER BY rs.active DESC,rs.display_name COLLATE NOCASE`,
      ).bind(tenantId).all<Record<string, unknown>>()
      return json(200, { staff: result.results.map(row => ({ ...row, active: Boolean(row.active) })) })
    }

    if (request.method === 'POST' && !staffId) {
      if (passwordRoute) return json(404, { error: 'staff_not_found' })
      const loginId = typeof body.login_id === 'string' ? body.login_id.trim() : ''
      const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      const role = typeof body.role === 'string' ? body.role : ''
      if (!LOGIN_ID.test(loginId) || !displayName || displayName.length > 100 ||
          password.length < 12 || password.length > 256 || !STAFF_ROLES.has(role)) {
        return json(400, { error: 'invalid_staff_account' })
      }
      const exists = await dataEnv.DB.prepare(
        'SELECT 1 AS found FROM platform_user_credentials WHERE login_id_normalized=? LIMIT 1',
      ).bind(loginId.toLowerCase()).first()
      const primaryExists = dataEnv.DB === env.DB ? null : await env.DB.prepare(
        'SELECT 1 AS found FROM platform_user_credentials WHERE login_id_normalized=? LIMIT 1',
      ).bind(loginId.toLowerCase()).first()
      if (exists || primaryExists) return json(409, { error: 'login_id_unavailable' })

      const userId = crypto.randomUUID()
      const passwordHash = await hashPassword(password)
      try {
        const results = await dataEnv.DB.batch([
          dataEnv.DB.prepare("INSERT INTO platform_users(id,auth_provider,auth_subject,email) VALUES(?,'native',?,NULL)")
            .bind(userId, userId),
          dataEnv.DB.prepare('INSERT INTO platform_user_credentials(user_id,login_id,login_id_normalized,password_hash) VALUES(?,?,?,?)')
            .bind(userId, loginId, loginId.toLowerCase(), passwordHash),
          dataEnv.DB.prepare("INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(?,?,'staff','active')")
            .bind(tenantId, userId),
          dataEnv.DB.prepare('INSERT INTO restaurant_staff(tenant_id,user_id,username,display_name,role,active) VALUES(?,?,?,?,?,1) RETURNING id')
            .bind(tenantId, userId, loginId.toLowerCase(), displayName, role),
          dataEnv.DB.prepare(
            "INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata) VALUES(?,?,'owner.staff.created','tenant',?,?)",
          ).bind(identity.issuer, identity.subject, tenantId, JSON.stringify({ staff_user_id: userId, login_id: loginId, role })),
        ])
        const staffRow = results[3]?.results?.[0] as { id?: string } | undefined
        if (!staffRow?.id) return json(500, { error: 'staff_create_failed' })
        return json(201, {
          staff: { staff_id: staffRow.id, user_id: userId, login_id: loginId, display_name: displayName, role, active: true },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        return json(/UNIQUE|constraint/i.test(message) ? 409 : 500, {
          error: /login_id|username/i.test(message) ? 'login_id_unavailable' : 'staff_create_failed',
        })
      }
    }

    if (request.method === 'POST' && staffId && passwordRoute) {
      const password = typeof body.password === 'string' ? body.password : ''
      if (password.length < 12 || password.length > 256) return json(400, { error: 'invalid_password' })
      const staff = await dataEnv.DB.prepare(
        'SELECT user_id FROM restaurant_staff WHERE tenant_id=? AND id=? AND user_id IS NOT NULL',
      ).bind(tenantId, staffId).first<{ user_id: string }>()
      if (!staff) return json(404, { error: 'staff_not_found' })
      const passwordHash = await hashPassword(password)
      await dataEnv.DB.batch([
        dataEnv.DB.prepare('UPDATE platform_user_credentials SET password_hash=?,password_changed_at=?,updated_at=? WHERE user_id=?')
          .bind(passwordHash, new Date().toISOString(), new Date().toISOString(), staff.user_id),
        dataEnv.DB.prepare('UPDATE platform_auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
          .bind(new Date().toISOString(), staff.user_id),
        dataEnv.DB.prepare(
          "INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata) VALUES(?,?,'owner.staff.password_reset','tenant',?,?)",
        ).bind(identity.issuer, identity.subject, tenantId, JSON.stringify({ staff_user_id: staff.user_id })),
      ])
      return json(200, { password_reset: true, sessions_revoked: true })
    }

    if (request.method === 'PATCH' && staffId && !passwordRoute) {
      const displayName = body.display_name
      const role = body.role
      const active = body.active
      if (displayName !== undefined && (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 100)) return json(400, { error: 'invalid_display_name' })
      if (role !== undefined && (typeof role !== 'string' || !STAFF_ROLES.has(role))) return json(400, { error: 'invalid_staff_role' })
      if (active !== undefined && typeof active !== 'boolean') return json(400, { error: 'invalid_staff_status' })
      if (displayName === undefined && role === undefined && active === undefined) return json(400, { error: 'empty_staff_update' })
      const staff = await dataEnv.DB.prepare(
        'SELECT user_id FROM restaurant_staff WHERE tenant_id=? AND id=? AND user_id IS NOT NULL',
      ).bind(tenantId, staffId).first<{ user_id: string }>()
      if (!staff) return json(404, { error: 'staff_not_found' })
      const assignments: string[] = []
      const values: unknown[] = []
      if (displayName !== undefined) { assignments.push('display_name=?'); values.push(displayName.trim()) }
      if (role !== undefined) { assignments.push('role=?'); values.push(role) }
      if (active !== undefined) { assignments.push('active=?'); values.push(active ? 1 : 0) }
      values.push(tenantId, staffId)
      const now = new Date().toISOString()
      const statements = [
        dataEnv.DB.prepare(`UPDATE restaurant_staff SET ${assignments.join(',')} WHERE tenant_id=? AND id=?`).bind(...values),
        ...(active === undefined ? [] : [
          dataEnv.DB.prepare('UPDATE tenant_memberships SET status=? WHERE tenant_id=? AND user_id=? AND role=\'staff\'')
            .bind(active ? 'active' : 'suspended', tenantId, staff.user_id),
        ]),
        ...(active === false ? [
          dataEnv.DB.prepare('UPDATE platform_auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(now, staff.user_id),
        ] : []),
        dataEnv.DB.prepare(
          "INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata) VALUES(?,?,'owner.staff.updated','tenant',?,?)",
        ).bind(identity.issuer, identity.subject, tenantId, JSON.stringify({ staff_user_id: staff.user_id, display_name: displayName, role, active })),
      ]
      await dataEnv.DB.batch(statements)
      return json(200, { updated: true, sessions_revoked: active === false })
    }

    return json(404, { error: 'staff_not_found' })
  } catch (error) {
    return errorResponse(error)
  }
}
