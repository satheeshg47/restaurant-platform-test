import { createRemoteJWKSet, jwtVerify } from 'jose'

interface D1Result<T> { results: T[]; success: boolean; meta?: { changes?: number } }
interface D1Statement {
  bind(...values: unknown[]): D1Statement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<D1Result<never>>
}
interface D1Database {
  prepare(sql: string): D1Statement
  batch<T = D1Result<never>>(statements: D1Statement[]): Promise<T[]>
}
interface Env {
  DB: D1Database
  ASSETS: { fetch(request: Request): Promise<Response> }
  OIDC_ISSUER?: string
  OIDC_AUDIENCE?: string
  OIDC_JWKS_URL?: string
  PLATFORM_ADMIN_SUBJECT?: string
  ENVIRONMENT?: string
}
interface AdminIdentity { issuer: string; subject: string }

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const APP_KEY = /^[a-z][a-z0-9-]{1,62}$/

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('Cache-Control', 'no-store')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function configured(env: Env): boolean {
  return Boolean(env.OIDC_ISSUER && env.OIDC_AUDIENCE && env.OIDC_JWKS_URL && env.PLATFORM_ADMIN_SUBJECT)
}

async function authenticateAdmin(request: Request, env: Env): Promise<AdminIdentity> {
  if (!configured(env)) throw Object.assign(new Error('admin_auth_not_configured'), { status: 503 })
  const authorization = request.headers.get('Authorization') || ''
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization)
  if (!match) throw Object.assign(new Error('unauthorized'), { status: 401 })
  try {
    const { payload } = await jwtVerify(
      match[1],
      createRemoteJWKSet(new URL(env.OIDC_JWKS_URL!)),
      { issuer: env.OIDC_ISSUER!, audience: env.OIDC_AUDIENCE!, algorithms: ['RS256', 'ES256'] },
    )
    if (typeof payload.sub !== 'string' || payload.sub !== env.PLATFORM_ADMIN_SUBJECT) {
      throw Object.assign(new Error('forbidden'), { status: 403 })
    }
    return { issuer: env.OIDC_ISSUER!, subject: payload.sub }
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error
    throw Object.assign(new Error('unauthorized'), { status: 401 })
  }
}

async function readJson(request: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('Content-Length') || 0)
  if (declared > maxBytes) throw Object.assign(new Error('payload_too_large'), { status: 413 })
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw Object.assign(new Error('payload_too_large'), { status: 413 })
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    return value as Record<string, unknown>
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 })
  }
}

async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  let admin: AdminIdentity
  try { admin = await authenticateAdmin(request, env) }
  catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 401
    return json(status, { error: status === 503 ? 'admin_auth_not_configured' : status === 403 ? 'forbidden' : 'unauthorized' })
  }

  if (path === '/admin/session' && request.method === 'GET') {
    return json(200, { authenticated: true, admin })
  }

  if (path === '/admin/applications' && request.method === 'GET') {
    try {
      const result = await env.DB.prepare(
        'SELECT id,app_key,name,status,created_at,updated_at FROM applications ORDER BY created_at DESC',
      ).all()
      return json(200, { applications: result.results })
    } catch {
      return json(500, { error: 'application_list_failed' })
    }
  }

  if (path === '/admin/applications' && request.method === 'POST') {
    let body: Record<string, unknown>
    try { body = await readJson(request) }
    catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 400
      return json(status, { error: status === 413 ? 'payload_too_large' : 'invalid_json' })
    }
    const appKey = typeof body.app_key === 'string' ? body.app_key.trim() : ''
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!APP_KEY.test(appKey) || name.length < 1 || name.length > 160) return json(400, { error: 'invalid_application' })

    const id = crypto.randomUUID()
    const metadata = JSON.stringify({ app_key: appKey, name })
    try {
      const results = await env.DB.batch([
        env.DB.prepare('INSERT INTO applications (id,app_key,name) VALUES (?,?,?)').bind(id, appKey, name),
        env.DB.prepare(
          'INSERT INTO platform_audit_events (actor_issuer,actor_subject,action,resource_type,resource_id,metadata) VALUES (?,?,?,?,?,?)',
        ).bind(admin.issuer, admin.subject, 'application.created', 'application', id, metadata),
      ])
      if (results.some(result => !result.success)) return json(500, { error: 'application_create_failed' })
      const application = await env.DB.prepare(
        'SELECT id,app_key,name,status,created_at,updated_at FROM applications WHERE id=?',
      ).bind(id).first()
      return json(201, { application })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      return json(/UNIQUE|constraint/i.test(message) ? 409 : 500, {
        error: /UNIQUE|constraint/i.test(message) ? 'application_key_exists' : 'application_create_failed',
      })
    }
  }

  if (path === '/admin/audit-events' && request.method === 'GET') {
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit') ?? 25)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
      return json(400, { error: 'invalid_pagination' })
    }
    try {
      const result = await env.DB.prepare(
        'SELECT id,actor_issuer,actor_subject,action,resource_type,resource_id,metadata,created_at,count(*) OVER() AS total_count FROM platform_audit_events ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',
      ).bind(limit, offset).all<Record<string, unknown>>()
      const total = result.results.length ? Number(result.results[0].total_count) : 0
      const events = result.results.map(({ total_count, metadata, ...event }) => ({
        ...event,
        metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
      }))
      return json(200, { events, pagination: { limit, offset, total, has_more: offset + events.length < total } })
    } catch {
      return json(500, { error: 'audit_events_list_failed' })
    }
  }

  if (path === '/admin/owners' && request.method === 'GET') {
    try {
      const result = await env.DB.prepare(
        `SELECT t.id AS tenant_id,t.name AS tenant_name,t.slug AS tenant_slug,t.status AS tenant_status,
          t.created_at AS tenant_created_at,pu.id AS user_id,pu.email,tm.role,
          tm.status AS membership_status,tm.created_at AS membership_created_at
         FROM tenants t
         LEFT JOIN tenant_memberships tm ON tm.tenant_id=t.id AND tm.role='owner'
         LEFT JOIN platform_users pu ON pu.id=tm.user_id
         ORDER BY t.created_at DESC,pu.email`,
      ).all<Record<string, unknown>>()
      return json(200, { owners: result.results.map(row => ({ ...row, owner_present: Boolean(row.user_id) })) })
    } catch {
      return json(500, { error: 'owner_directory_failed' })
    }
  }

  if (path === '/admin/owner-invitations' && request.method === 'GET') {
    try {
      const result = await env.DB.prepare(
        `SELECT i.id,i.tenant_id,t.name AS tenant_name,t.slug AS tenant_slug,i.email,i.status,i.created_at,i.expires_at
         FROM platform_owner_invitations i JOIN tenants t ON t.id=i.tenant_id
         ORDER BY i.created_at DESC LIMIT 500`,
      ).all()
      return json(200, { invitations: result.results })
    } catch {
      return json(500, { error: 'owner_invitation_list_failed' })
    }
  }

  return json(405, { error: 'method_not_allowed' })
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/api/, '') || '/'
  if (path === '/health' && request.method === 'GET') {
    return json(200, { status: 'ok', service: 'platform-core-api', environment: env.ENVIRONMENT || 'production', checks: { process: 'ok', database: 'configured' } })
  }
  if (path === '/ready' && request.method === 'GET') {
    try {
      await env.DB.prepare('SELECT 1 AS ok').first()
      return json(200, { status: 'ready', checks: { database: 'ok' } })
    } catch {
      return json(503, { status: 'not_ready', checks: { database: 'unavailable' } })
    }
  }
  if (path.startsWith('/admin/')) return handleAdmin(request, env, path)
  if (path.startsWith('/restaurant/') || path.startsWith('/owner/')) {
    return json(501, { error: 'module_not_migrated_to_d1' })
  }
  return json(404, { error: 'not_found' })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return withSecurityHeaders(await handleApi(request, env))
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request))
  },
}
