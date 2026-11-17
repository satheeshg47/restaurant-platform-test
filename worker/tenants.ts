import { authenticateAdmin, authStatus } from './auth.ts'
import type { Env, Identity, D1Result } from './types.ts'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > 8192) throw Object.assign(new Error('payload_too_large'), { status: 413 })
  try {
    const body: unknown = JSON.parse(raw)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid')
    return body as Record<string, unknown>
  } catch { throw Object.assign(new Error('invalid_json'), { status: 400 }) }
}

export async function handleAdminTenants(request: Request, env: Env, path: string): Promise<Response> {
  if (path !== '/admin/tenants' || request.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  let admin: Identity
  try { admin = await authenticateAdmin(request, env) }
  catch (error) {
    const status = authStatus(error, 401)
    return json(status, { error: status === 503 ? 'admin_auth_not_configured' : status === 403 ? 'forbidden' : 'unauthorized' })
  }

  let body: Record<string, unknown>
  try { body = await readBody(request) }
  catch (error) {
    const status = authStatus(error, 400)
    return json(status, { error: status === 413 ? 'payload_too_large' : 'invalid_json' })
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : ''
  if (!name || name.length > 160 || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug) || slug.endsWith('-')) {
    return json(400, { error: 'invalid_tenant' })
  }

  try {
    const application = await env.DB.prepare(
      "SELECT id FROM applications WHERE app_key='restaurant' AND status='active' LIMIT 1",
    ).first<{ id: string }>()
    if (!application) return json(503, { error: 'restaurant_application_not_configured' })

    const id = crypto.randomUUID()
    const results = await env.DB.batch<D1Result<Record<string, unknown>>>([
      env.DB.prepare(
        "INSERT INTO tenants(id,name,slug,status) VALUES(?,?,?,'active') RETURNING id,name,slug,status,created_at",
      ).bind(id, name, slug),
      env.DB.prepare(
        "INSERT INTO tenant_applications(tenant_id,application_id,status) VALUES(?,?,'active')",
      ).bind(id, application.id),
      env.DB.prepare(
        `INSERT INTO restaurant_profiles
          (tenant_id,display_name,currency_code,timezone,default_language,tax_mode,tax_rate,gst_rate,tax_inclusive,accepting_orders)
         VALUES(?,?,'INR','Asia/Kolkata','en','none',0,5,0,1)`,
      ).bind(id, name),
      env.DB.prepare(
        `INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata)
         VALUES(?,?,'tenant.created','tenant',?,?)`,
      ).bind(admin.issuer, admin.subject, id, JSON.stringify({ name, slug, application: 'restaurant' })),
    ])
    const tenant = results[0]?.results?.[0]
    if (!tenant) return json(500, { error: 'tenant_create_failed' })
    return json(201, { tenant, application: 'restaurant', owner_invitation_required: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    return json(/UNIQUE|constraint/i.test(message) ? 409 : 500, {
      error: /UNIQUE|constraint/i.test(message) ? 'tenant_slug_exists' : 'tenant_create_failed',
    })
  }
}
