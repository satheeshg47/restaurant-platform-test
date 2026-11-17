import { authenticateIdentity } from './auth.ts'
import { handleRestaurantMenuRoutes } from './menu.ts'
import { handleOrderOperations } from './order-operations.ts'
import { handleRestaurantFinance } from './restaurant-finance.ts'
import { handleGuestReviewRoutes, handleRestaurantReviewRoutes } from './restaurant-reviews.ts'
import { handleRestaurantDataExport } from './restaurant-export.ts'
import { handleGuestOrder } from './guest-orders.ts'
import type { Env, Identity } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const QR_TOKEN = /^[A-Za-z0-9_-]{43}$/
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
}

function fail(status: number, code: string): never {
  throw Object.assign(new Error(code), { status })
}

function errorResponse(error: unknown, fallback: string): Response {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500
  const code = error instanceof Error && status < 500 ? error.message : fallback
  return json(status, { error: code })
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('Content-Length') || 0)
  if (declared > 8192) fail(413, 'payload_too_large')
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > 8192) fail(413, 'payload_too_large')
  try {
    const body: unknown = JSON.parse(raw)
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_json')
    return body as Record<string, unknown>
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error
    fail(400, 'invalid_json')
  }
}

function parseJson(value: unknown, fallback: unknown = {}) {
  if (typeof value !== 'string') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

interface TenantActor {
  tenantId: string
  userId: string
  staffId: string | null
  role: string
}

async function resolveTenant(env: Env, slug: string): Promise<string> {
  const tenant = await env.DB.prepare(
    "SELECT id FROM tenants WHERE slug=? AND status='active' LIMIT 1",
  ).bind(slug).first<{ id: string }>()
  if (!tenant) fail(404, 'restaurant_not_found')
  return tenant.id
}

async function authenticateTenant(env: Env, tenantId: string, identity: Identity): Promise<TenantActor> {
  const enabled = await env.DB.prepare(
    `SELECT 1 AS enabled FROM tenant_applications ta
     JOIN applications a ON a.id=ta.application_id
     WHERE ta.tenant_id=? AND ta.status='active' AND a.app_key='restaurant' AND a.status='active' LIMIT 1`,
  ).bind(tenantId).first()
  if (!enabled) fail(403, 'restaurant_application_not_enabled')

  const row = await env.DB.prepare(
    `SELECT pu.id AS user_id,tm.role AS membership_role,
       rs.id AS staff_id,rs.role AS staff_role
     FROM platform_users pu
     JOIN tenant_memberships tm ON tm.user_id=pu.id
     LEFT JOIN restaurant_staff rs ON rs.tenant_id=tm.tenant_id AND rs.user_id=pu.id AND rs.active=1
     WHERE pu.auth_provider=? AND pu.auth_subject=? AND tm.tenant_id=? AND tm.status='active'
     LIMIT 1`,
  ).bind(identity.issuer, identity.subject, tenantId).first<{
    user_id: string; membership_role: string; staff_id: string | null; staff_role: string | null
  }>()
  if (!row) fail(403, 'restaurant_membership_required')
  if (row.membership_role === 'owner' || row.membership_role === 'admin') {
    return { tenantId, userId: row.user_id, staffId: row.staff_id, role: 'owner' }
  }
  if (row.membership_role === 'staff' && row.staff_id && row.staff_role) {
    return { tenantId, userId: row.user_id, staffId: row.staff_id, role: row.staff_role }
  }
  fail(403, 'restaurant_role_forbidden')
}

function requireRole(actor: TenantActor, allowed: string[]) {
  if (!allowed.includes(actor.role)) fail(403, 'restaurant_role_forbidden')
}

async function loadMenu(env: Env, tenantId: string) {
  const [profile, categories, items, variants, addonGroups, addons, itemAddonGroups] = await Promise.all([
    env.DB.prepare(
      `SELECT display_name,currency_code,timezone,default_language,tax_mode,tax_rate,gst_rate,
        tax_inclusive,accepting_orders,legal_name,gstin,address_line1,address_line2,city,state_name,state_code,postal_code,invoice_prefix
       FROM restaurant_profiles WHERE tenant_id=?`,
    ).bind(tenantId).first<Record<string, unknown>>(),
    env.DB.prepare('SELECT * FROM restaurant_menu_categories WHERE tenant_id=? ORDER BY sort_order,name').bind(tenantId).all<Record<string, unknown>>(),
    env.DB.prepare('SELECT * FROM restaurant_menu_items WHERE tenant_id=? ORDER BY category_id,sort_order,name').bind(tenantId).all<Record<string, unknown>>(),
    env.DB.prepare('SELECT * FROM restaurant_menu_variants WHERE tenant_id=? ORDER BY item_id,sort_order,name').bind(tenantId).all<Record<string, unknown>>(),
    env.DB.prepare('SELECT * FROM restaurant_addon_groups WHERE tenant_id=? ORDER BY sort_order,name').bind(tenantId).all<Record<string, unknown>>(),
    env.DB.prepare('SELECT * FROM restaurant_addons WHERE tenant_id=? ORDER BY group_id,sort_order,name').bind(tenantId).all<Record<string, unknown>>(),
    env.DB.prepare('SELECT * FROM restaurant_item_addon_groups WHERE tenant_id=? ORDER BY item_id,group_id').bind(tenantId).all<Record<string, unknown>>(),
  ])
  const parseRows = (rows: Record<string, unknown>[], columns: string[]) => rows.map(row => {
    const output = { ...row }
    for (const column of columns) output[column] = parseJson(output[column])
    return output
  })
  return {
    restaurant: profile ? { ...profile, tax_inclusive: Boolean(profile.tax_inclusive), accepting_orders: Boolean(profile.accepting_orders) } : null,
    categories: parseRows(categories.results, ['name','schedule']),
    items: parseRows(items.results, ['name','description','schedule']),
    variants: parseRows(variants.results, ['name']),
    addon_groups: parseRows(addonGroups.results, ['name']),
    addons: parseRows(addons.results, ['name']),
    item_addon_groups: itemAddonGroups.results,
  }
}

async function handleGuestMenu(env: Env, tenantId: string, token: string): Promise<Response> {
  if (!QR_TOKEN.test(token)) return json(404, { error: 'qr_not_found' })
  try {
    const hash = await sha256(token)
    const table = await env.DB.prepare(
      'SELECT id,label,table_type FROM restaurant_tables WHERE tenant_id=? AND public_token_hash=? AND active=1 LIMIT 1',
    ).bind(tenantId, hash).first<Record<string, unknown>>()
    if (!table) return json(404, { error: 'qr_not_found' })
    const [menu, session] = await Promise.all([
      loadMenu(env, tenantId),
      env.DB.prepare(
        "SELECT id,status FROM restaurant_table_sessions WHERE tenant_id=? AND table_id=? AND status='open' LIMIT 1",
      ).bind(tenantId, table.id).first(),
    ])
    const categories = menu.categories.filter(row => Boolean(row.active))
    const categoryIds = new Set(categories.map(row => String(row.id)))
    const items = menu.items.filter(row => Boolean(row.active) && categoryIds.has(String(row.category_id)))
    const itemIds = new Set(items.map(row => String(row.id)))
    const addon_groups = menu.addon_groups.filter(row => Boolean(row.active))
    const groupIds = new Set(addon_groups.map(row => String(row.id)))
    const variants = menu.variants.filter(row => Boolean(row.active) && itemIds.has(String(row.item_id)))
    const addons = menu.addons.filter(row => Boolean(row.active) && groupIds.has(String(row.group_id)))
    const item_addon_groups = menu.item_addon_groups.filter(row => itemIds.has(String(row.item_id)) && groupIds.has(String(row.group_id)))
    return json(200, { table, session: session ?? null, ...menu, categories, items, variants, addon_groups, addons, item_addon_groups })
  } catch { return json(500, { error: 'restaurant_menu_unavailable' }) }
}

function normalizeSettings(profile: Record<string, unknown>) {
  return {
    ...profile,
    tax_inclusive: Boolean(profile.tax_inclusive),
    accepting_orders: Boolean(profile.accepting_orders),
  }
}

async function handleSettings(request: Request, env: Env, actor: TenantActor): Promise<Response> {
  requireRole(actor, ['owner','manager'])
  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      `SELECT display_name,currency_code,timezone,default_language,tax_mode,tax_rate,gst_rate,
        tax_inclusive,accepting_orders,legal_name,gstin,address_line1,address_line2,city,state_name,state_code,postal_code,invoice_prefix
       FROM restaurant_profiles WHERE tenant_id=?`,
    ).bind(actor.tenantId).first<Record<string, unknown>>()
    if (!row) fail(404, 'restaurant_profile_not_configured')
    return json(200, { settings: normalizeSettings(row) })
  }
  if (request.method !== 'PATCH') return json(405, { error: 'method_not_allowed' })
  const body = await readBody(request)
  const allowed = new Set(['display_name','currency_code','timezone','default_language','tax_mode','tax_rate','gst_rate','tax_inclusive','accepting_orders','legal_name','gstin','address_line1','address_line2','city','state_name','state_code','postal_code','invoice_prefix'])
  if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.has(key))) fail(400, 'invalid_settings')
  const current = await env.DB.prepare('SELECT * FROM restaurant_profiles WHERE tenant_id=?').bind(actor.tenantId).first<Record<string, unknown>>()
  if (!current) fail(404, 'restaurant_profile_not_configured')
  const merged: Record<string, unknown> = { ...current, ...body }
  if (typeof merged.display_name !== 'string' || !merged.display_name.trim() || merged.display_name.trim().length > 160) fail(400, 'invalid_settings')
  if (merged.currency_code !== 'INR' || merged.timezone !== 'Asia/Kolkata' || !['en','hi','kn'].includes(String(merged.default_language))) fail(400, 'invalid_settings')
  if (!['none','single','gst'].includes(String(merged.tax_mode))) fail(400, 'invalid_settings')
  for (const key of ['tax_rate','gst_rate']) {
    const value = Number(merged[key])
    if (!Number.isFinite(value) || value < 0 || value > 100) fail(400, 'invalid_settings')
    merged[key] = value
  }
  for (const key of ['tax_inclusive','accepting_orders']) if (typeof merged[key] !== 'boolean' && merged[key] !== 0 && merged[key] !== 1) fail(400, 'invalid_settings')
  const optionalText = ['legal_name','address_line1','address_line2','city','state_name','postal_code']
  for (const key of optionalText) {
    if (merged[key] === '') merged[key] = null
    if (merged[key] !== null && merged[key] !== undefined && (typeof merged[key] !== 'string' || merged[key].length > 200)) fail(400, 'invalid_settings')
  }
  if (merged.gstin === '') merged.gstin = null
  if (merged.gstin !== null && merged.gstin !== undefined && (typeof merged.gstin !== 'string' || !GSTIN.test(merged.gstin))) fail(400, 'invalid_gstin')
  if (merged.state_code === '') merged.state_code = null
  if (merged.state_code !== null && merged.state_code !== undefined && (typeof merged.state_code !== 'string' || !/^\d{2}$/.test(merged.state_code))) fail(400, 'invalid_state_code')
  if (typeof merged.invoice_prefix !== 'string' || !/^[A-Z0-9]{1,3}$/.test(merged.invoice_prefix)) fail(400, 'invalid_invoice_prefix')
  const columns = ['display_name','currency_code','timezone','default_language','tax_mode','tax_rate','gst_rate','tax_inclusive','accepting_orders','legal_name','gstin','address_line1','address_line2','city','state_name','state_code','postal_code','invoice_prefix']
  const values = columns.map(key => key === 'display_name' ? String(merged[key]).trim() : (key === 'tax_inclusive' || key === 'accepting_orders') ? Number(Boolean(merged[key])) : merged[key] ?? null)
  const assignments = columns.map((key,index) => `${key}=?`).join(',')
  const result = await env.DB.prepare(
    `UPDATE restaurant_profiles SET ${assignments},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE tenant_id=? RETURNING display_name,currency_code,timezone,default_language,tax_mode,tax_rate,gst_rate,
       tax_inclusive,accepting_orders,legal_name,gstin,address_line1,address_line2,city,state_name,state_code,postal_code,invoice_prefix`,
  ).bind(...values, actor.tenantId).all<Record<string, unknown>>()
  if (!result.results[0]) fail(404, 'restaurant_profile_not_configured')
  return json(200, { settings: normalizeSettings(result.results[0]) })
}

async function handleTables(request: Request, env: Env, actor: TenantActor, parts: string[]): Promise<Response> {
  const tableId = parts[3]
  if (parts.length === 3 && request.method === 'GET') {
    requireRole(actor, ['owner','manager','waiter'])
    const result = await env.DB.prepare(
      `SELECT t.id,t.table_number,t.label,t.table_type,t.active,
        s.id AS session_id,s.opened_at,s.guest_count,
        (SELECT count(*) FROM restaurant_service_requests r WHERE r.tenant_id=t.tenant_id AND r.table_id=t.id AND r.status='open') AS open_requests
       FROM restaurant_tables t
       LEFT JOIN restaurant_table_sessions s ON s.tenant_id=t.tenant_id AND s.table_id=t.id AND s.status='open'
       WHERE t.tenant_id=?
       ORDER BY t.table_type,t.table_number IS NULL,t.table_number,t.label`,
    ).bind(actor.tenantId).all()
    return json(200, { tables: result.results.map(row => ({ ...row, active: Boolean(row.active) })) })
  }

  if (parts.length === 3 && request.method === 'POST') {
    requireRole(actor, ['owner','manager'])
    const body = await readBody(request)
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    const tableType = body.table_type ?? 'dine_in'
    const tableNumber = body.table_number ?? null
    if (!label || label.length > 80 || !['dine_in','takeaway'].includes(String(tableType)) ||
        (tableNumber !== null && (typeof tableNumber !== 'number' || !Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 9999)) ||
        (tableType === 'takeaway' && tableNumber !== null)) fail(400, 'invalid_table')
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)))
    const hash = await sha256(token)
    try {
      const result = await env.DB.prepare(
        `INSERT INTO restaurant_tables(tenant_id,table_number,label,table_type,public_token_hash)
         VALUES(?,?,?,?,?) RETURNING id,table_number,label,table_type,active`,
      ).bind(actor.tenantId, tableNumber, label, tableType, hash).all<Record<string, unknown>>()
      const row = result.results[0]
      if (!row) fail(500, 'table_create_failed')
      return json(201, { table: { ...row, active: Boolean(row.active) }, qr_token: token })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      return json(/UNIQUE|constraint/i.test(message) ? 409 : 500, { error: /UNIQUE|constraint/i.test(message) ? 'table_number_exists' : 'table_create_failed' })
    }
  }

  if (parts.length === 5 && parts[4] === 'sessions' && request.method === 'POST') {
    if (!UUID.test(tableId || '')) fail(404, 'table_not_found')
    requireRole(actor, ['owner','manager','waiter'])
    const body = await readBody(request)
    const guestCount = body.guest_count ?? null
    if (guestCount !== null && (typeof guestCount !== 'number' || !Number.isInteger(guestCount) || guestCount < 1 || guestCount > 100)) fail(400, 'invalid_guest_count')
    const table = await env.DB.prepare(
      'SELECT id FROM restaurant_tables WHERE tenant_id=? AND id=? AND active=1',
    ).bind(actor.tenantId, tableId).first()
    if (!table) fail(404, 'table_not_found')
    try {
      const result = await env.DB.prepare(
        `INSERT INTO restaurant_table_sessions(tenant_id,table_id,guest_count,opened_by)
         VALUES(?,?,?,?) RETURNING id,table_id,status,guest_count,opened_at`,
      ).bind(actor.tenantId, tableId, guestCount, actor.staffId).all<Record<string, unknown>>()
      return json(201, { session: result.results[0] })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      return json(/UNIQUE|constraint/i.test(message) ? 409 : 500, { error: /UNIQUE|constraint/i.test(message) ? 'table_session_already_open' : 'table_session_open_failed' })
    }
  }

  if (parts.length === 7 && parts[4] === 'sessions' && parts[6] === 'close' && request.method === 'POST') {
    const sessionId = parts[5]
    if (!UUID.test(tableId || '') || !UUID.test(sessionId || '')) fail(404, 'session_not_found')
    requireRole(actor, ['owner','manager','waiter'])
    const session = await env.DB.prepare(
      "SELECT id FROM restaurant_table_sessions WHERE tenant_id=? AND table_id=? AND id=? AND status='open'",
    ).bind(actor.tenantId, tableId, sessionId).first()
    if (!session) fail(404, 'session_not_found')
    const totals = await env.DB.prepare(
      `SELECT
        COALESCE((SELECT sum(total_minor) FROM restaurant_orders WHERE tenant_id=? AND session_id=? AND status<>'cancelled'),0) AS total_due,
        COALESCE((SELECT sum(amount_minor) FROM restaurant_payments WHERE tenant_id=? AND session_id=?),0) AS paid,
        COALESCE((SELECT sum(amount_minor) FROM restaurant_refunds WHERE tenant_id=? AND session_id=? AND was_paid=1),0) AS paid_refunds,
        COALESCE((SELECT sum(amount_minor) FROM restaurant_refunds WHERE tenant_id=? AND session_id=? AND was_paid=0),0) AS waived,
        EXISTS(SELECT 1 FROM restaurant_orders WHERE tenant_id=? AND session_id=? AND status NOT IN ('served','cancelled')) AS unfinished`,
    ).bind(actor.tenantId,sessionId,actor.tenantId,sessionId,actor.tenantId,sessionId,actor.tenantId,sessionId,actor.tenantId,sessionId).first<Record<string, unknown>>()
    if (Number(totals?.unfinished)) fail(409, 'orders_not_completed')
    const paid = BigInt(String(totals?.paid ?? 0)) - BigInt(String(totals?.paid_refunds ?? 0))
    const due = BigInt(String(totals?.total_due ?? 0)) - BigInt(String(totals?.waived ?? 0))
    if (paid < due) fail(409, 'payment_due')
    const result = await env.DB.prepare(
      `UPDATE restaurant_table_sessions SET status='closed',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),closed_by=?,close_reason='staff'
       WHERE tenant_id=? AND table_id=? AND id=? AND status='open' RETURNING id,status,closed_at`,
    ).bind(actor.staffId, actor.tenantId, tableId, sessionId).all()
    if (!result.results[0]) fail(404, 'session_not_found')
    return json(200, { session: result.results[0] })
  }

  return json(404, { error: 'restaurant_route_not_found' })
}

export async function handleRestaurantRoutes(request: Request, env: Env, path: string): Promise<Response> {
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2 || parts[0] !== 'restaurant') return json(404, { error: 'restaurant_not_found' })
  const slug = parts[1]
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return json(404, { error: 'restaurant_not_found' })
  let tenantId: string
  try { tenantId = await resolveTenant(env, slug) }
  catch (error) { return errorResponse(error, 'restaurant_lookup_failed') }

  if (parts[2] === 'guest' && parts.length === 5 && parts[4] === 'menu' && request.method === 'GET') {
    return handleGuestMenu(env, tenantId, parts[3])
  }
  if (parts[2] === 'guest' && parts.length === 5 && parts[4] === 'orders' && request.method === 'POST') return handleGuestOrder(request, env, tenantId, parts[3])
  if (parts[2] === 'guest' && parts.length === 5 && parts[4] === 'reviews') return handleGuestReviewRoutes(request, env, tenantId, parts[3])
  if (parts[2] === 'guest') return json(501, { error: 'guest_ordering_not_migrated_to_d1' })

  let identity: Identity
  try { identity = await authenticateIdentity(request, env) }
  catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 401
    return json(status, { error: status === 503 ? 'identity_auth_not_configured' : status === 403 ? 'forbidden' : 'unauthorized' })
  }
  let actor: TenantActor
  try { actor = await authenticateTenant(env, tenantId, identity) }
  catch (error) { return errorResponse(error, 'restaurant_access_failed') }

  try {
    if (parts[2] === 'settings' && parts.length === 3) return await handleSettings(request, env, actor)
    if (parts[2] === 'tables') return await handleTables(request, env, actor, parts)
    if (parts[2] === 'menu') return await handleRestaurantMenuRoutes(request, env, actor, parts)
    const finance = await handleRestaurantFinance(request, env, actor, parts, new URL(request.url))
    if (finance) return finance
    if (parts[2] === 'reviews') {
      const reviews = await handleRestaurantReviewRoutes(request, env, actor, parts)
      if (reviews) return reviews
    }
    if (parts[2] === 'data-export') {
      const exported = await handleRestaurantDataExport(request, env, actor, parts)
      if (exported) return exported
    }
    if (parts[2] === 'kitchen' || parts[2] === 'waiter') {
      const operation = await handleOrderOperations(request, env, actor, parts)
      if (operation) return operation
    }
    if (false && ['data-export'].includes(parts[2] || '')) return json(501, { error: 'restaurant_module_not_migrated_to_d1' })
    return json(404, { error: 'restaurant_route_not_found' })
  } catch (error) {
    return errorResponse(error, 'restaurant_request_failed')
  }
}
