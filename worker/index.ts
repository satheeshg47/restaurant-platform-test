import { authenticateAdmin } from './auth.ts'
import { handleNativeAuth } from './native-auth.ts'
import { handleCommunications } from './communications.ts'
import { handleOwnerInvitations } from './owner-invitations.ts'
import { handleOwnerStaff } from './owner-staff.ts'
import { handleAdminTenants } from './tenants.ts'
import { handleAdminSubscriptions } from './admin-subscriptions.ts'
import { handleAdminMonitoring } from './admin-monitoring.ts'
import { handleRestaurantRoutes } from './restaurant.ts'
import { handleOwnerRestaurants } from './owner-portal.ts'
import { handleDemoProvision } from './demo.ts'
import type { Env, Identity } from './types.ts'
import { validateReleaseManifest } from './release-manifest.ts'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
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
  let admin: Identity
  try { admin = await authenticateAdmin(request, env) }
  catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 401
    return json(status, { error: status === 503 ? 'admin_auth_not_configured' : status === 403 ? 'forbidden' : 'unauthorized' })
  }

  if (path === '/admin/demo-restaurant/provision') return handleDemoProvision(request, env)

  if (path === '/admin/session' && request.method === 'GET') {
    return json(200, { authenticated: true, admin })
  }

  if (path === '/admin/monitoring') {
    const monitoring = await handleAdminMonitoring(request, env, admin)
    if (monitoring) return monitoring
  }

  if (path.startsWith('/admin/subscription-plans') || path.startsWith('/admin/subscriptions') || path.startsWith('/admin/subscription-payments/')) {
    const subscriptions = await handleAdminSubscriptions(request, env, path, admin)
    if (subscriptions) return subscriptions
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

  if (path === '/admin/releases/validate-manifest' && request.method === 'POST') {
    let body: Record<string, unknown>
    try { body = await readJson(request, 256 * 1024) }
    catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 400
      return json(status, { error: status === 413 ? 'payload_too_large' : 'invalid_json' })
    }
    const validation = validateReleaseManifest(body.manifest)
    if (!validation.valid) return json(400, { valid: false, errors: validation.errors })
    const manifest = validation.manifest as { app_key: string; version: string; database_migration_version: number }
    try {
      const application = await env.DB.prepare('SELECT id,name,status FROM applications WHERE app_key=?').bind(manifest.app_key).first<{id:string;name:string;status:string}>()
      if (!application) return json(404, { valid:false,error:'application_not_found' })
      if (application.status !== 'active') return json(409, { valid:false,error:'application_not_active' })
      const duplicate = await env.DB.prepare('SELECT id FROM application_releases WHERE application_id=? AND version=?').bind(application.id,manifest.version).first()
      if (duplicate) return json(409, { valid:false,error:'release_version_exists' })
      const migration = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY name DESC LIMIT 1').first<{name:string}>()
      const currentMigration = Number(/^([0-9]+)/.exec(migration?.name || '')?.[1] || 0)
      if (manifest.database_migration_version > currentMigration) return json(409,{valid:false,error:'database_migration_not_available',current_migration_version:currentMigration,requested_migration_version:manifest.database_migration_version})
      return json(200,{valid:true,application:{id:application.id,name:application.name,app_key:manifest.app_key},manifest:validation.manifest,total_bytes:validation.total_bytes,checks:{application_active:true,version_available:true,migration_compatible:true,metadata_valid:true},limitations:['This validates manifest metadata only.','It does not receive or inspect a ZIP archive, verify package file hashes, store artifacts, or authorize deployment.']})
    } catch { return json(500,{error:'release_manifest_preflight_failed'}) }
  }

  if (path === '/admin/releases' && request.method === 'GET') {
    try {
      const [releaseResult, deploymentResult] = await Promise.all([
        env.DB.prepare(`SELECT r.id,r.application_id,a.name AS application_name,a.app_key,r.version,r.package_sha256,r.status,r.uploaded_by,r.reviewed_by,r.reviewed_at,r.created_at,r.manifest FROM application_releases r JOIN applications a ON a.id=r.application_id ORDER BY r.created_at DESC,r.id DESC LIMIT 100`).all<Record<string, unknown>>(),
        env.DB.prepare(`SELECT d.id,d.application_id,a.name AS application_name,d.release_id,r.version,d.environment,d.status,d.started_at,d.finished_at,d.created_at,d.health_report FROM application_deployments d JOIN applications a ON a.id=d.application_id JOIN application_releases r ON r.id=d.release_id ORDER BY d.created_at DESC,d.id DESC LIMIT 100`).all<Record<string, unknown>>(),
      ])
      const parseJson = (value: unknown) => {
        if (typeof value !== 'string') return value ?? {}
        try { return JSON.parse(value) } catch { return { invalid_json: true } }
      }
      const releases = releaseResult.results.map(({ manifest, ...release }) => ({ ...release, manifest: parseJson(manifest) }))
      const deployments = deploymentResult.results.map(({ health_report, ...deployment }) => ({ ...deployment, health_report: parseJson(health_report) }))
      return json(200, { releases, deployments, generated_at: new Date().toISOString() })
    } catch {
      return json(500, { error: 'release_registry_unavailable' })
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
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.has('Cookie')) {
    const origin = request.headers.get('Origin')
    if (origin) {
      try {
        if (new URL(origin).origin !== url.origin) return json(403, { error: 'origin_not_allowed' })
      } catch {
        return json(403, { error: 'origin_not_allowed' })
      }
    }
  }
  const nativeAuthResponse = await handleNativeAuth(request, env, path)
  if (nativeAuthResponse) return nativeAuthResponse
  if (path === '/health' && request.method === 'GET') {
    return json(200, { status: 'ok', service: 'platform-core-api', environment: env.ENVIRONMENT || 'production', checks: { process: 'ok', database: 'configured' } })
  }
  if (path === '/ready' && request.method === 'GET') {
    try {
      const schema = await env.DB.prepare(
        `SELECT
          (SELECT name FROM d1_migrations ORDER BY name DESC LIMIT 1) AS latest_migration,
          (SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN (
            'application_deployments','application_releases','applications','audit_events',
            'communication_conversations','communication_messages','communication_participants',
            'owner_transfer_requests','platform_audit_events','platform_owner_invitations','platform_users',
            'restaurant_activity_events','restaurant_addon_groups','restaurant_addons','restaurant_batch_allocations',
            'restaurant_daily_summaries','restaurant_invoice_counters','restaurant_invoices','restaurant_item_addon_groups',
            'restaurant_kitchen_batches','restaurant_menu_categories','restaurant_menu_items','restaurant_menu_variants',
            'restaurant_order_items','restaurant_orders','restaurant_payments','restaurant_profiles','restaurant_refunds',
            'restaurant_reviews','restaurant_service_requests','restaurant_settings','restaurant_staff',
            'restaurant_staff_assignments','restaurant_stock_events','restaurant_table_sessions','restaurant_tables',
            'restaurant_tenant_controls','subscription_payments','subscription_plans','subscriptions',
            'tenant_applications','tenant_memberships','tenants',
            'platform_user_credentials','platform_auth_sessions','platform_auth_challenges','platform_auth_recovery_codes',
            'platform_admin_accounts','platform_auth_rate_limits','tenant_membership_permissions'
          )) AS required_tables`,
      ).first<{ latest_migration: string | null; required_tables: number }>()
      if (schema?.latest_migration !== '0009_totp_replay_protection.sql' || Number(schema.required_tables) !== 50) {
        return json(503, { status: 'not_ready', checks: { database: 'ok', schema: 'incomplete' }, required_migration: '0009_totp_replay_protection.sql' })
      }
      return json(200, { status: 'ready', checks: { database: 'ok', schema: 'complete' }, latest_migration: schema.latest_migration })
    } catch {
      return json(503, { status: 'not_ready', checks: { database: 'unavailable', schema: 'incomplete' } })
    }
  }
  if (path === '/admin/owner-invitations' || path.startsWith('/admin/owner-invitations/') || path === '/owner/invitations/accept') return handleOwnerInvitations(request, env, path)
  if (path.startsWith('/admin/communications') || path.startsWith('/owner/communications')) return handleCommunications(request, env, path)
  if (path === '/admin/tenants' || path.startsWith('/admin/tenants/')) return handleAdminTenants(request, env, path)
  if (path === '/owner/staff' || path.startsWith('/owner/staff/')) return (await handleOwnerStaff(request, env, path)) || json(404, { error: 'not_found' })
  if (path === '/owner/restaurants') return handleOwnerRestaurants(request, env)
  if (path.startsWith('/admin/')) return handleAdmin(request, env, path)
  if (path.startsWith('/restaurant/')) return handleRestaurantRoutes(request, env, path)
  if (path.startsWith('/owner/')) return json(501, { error: 'module_not_migrated_to_d1' })
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
