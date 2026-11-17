import { createHash, randomBytes } from 'node:crypto'
import { withTenantTransaction } from '../db/pool.mjs'
import { createPresignedObjectUrl } from '../storage/object-storage.mjs'
import { handleGuestOrder } from './orders.mjs'
import { handleKitchenRoutes } from './kitchen.mjs'
import { handleGuestLifecycle, handleWaiterRoutes } from './waiter.mjs'
import { handleOwnerMenuRoutes } from './menu.mjs'
import { handleRestaurantSettings } from './settings.mjs'
import { handleRestaurantReports } from './reports.mjs'
import { handleRestaurantReviews } from './reviews.mjs'
import { handleRestaurantDailySummary } from './daily-summary.mjs'
import { handleRestaurantRefund } from './refunds.mjs'
import { handleRestaurantInvoice } from './invoices.mjs'
import { handleRestaurantDataExport } from './data-export.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/
const TOKEN = /^[A-Za-z0-9_-]{40,48}$/
const MAX_BODY_BYTES = 8192

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
    return value
  } catch {
    const error = new Error('Invalid JSON object')
    error.statusCode = 400
    throw error
  }
}

function fail(statusCode, code) {
  const error = new Error(code)
  error.statusCode = statusCode
  throw error
}

async function resolveTenant(database, slug) {
  if (!SLUG.test(slug)) fail(404, 'restaurant_not_found')
  const result = await database.query(
    "SELECT id FROM tenants WHERE slug=$1 AND status='active'",
    [slug],
  )
  if (!result.rows[0]) fail(404, 'restaurant_not_found')
  return result.rows[0].id
}

async function authenticateTenant(database, tenantId, identity) {
  if (!identity || typeof identity.issuer !== 'string' || typeof identity.subject !== 'string') {
    fail(401, 'unauthorized')
  }
  return withTenantTransaction(database, tenantId, async client => {
    const application = await client.query(
      `SELECT a.id FROM applications a
       JOIN tenant_applications ta ON ta.application_id=a.id
       WHERE a.app_key='restaurant' AND a.status='active' AND ta.tenant_id=$1 AND ta.status='active'
       LIMIT 1`,
      [tenantId],
    )
    if (!application.rows[0]) fail(403, 'restaurant_application_not_enabled')
    const result = await client.query(
      `SELECT pu.id AS user_id, tm.role AS membership_role, rs.id AS staff_id, rs.role AS staff_role
       FROM platform_users pu
       JOIN tenant_memberships tm ON tm.user_id=pu.id AND tm.tenant_id=$3
       LEFT JOIN restaurant_staff rs ON rs.user_id=pu.id AND rs.tenant_id=tm.tenant_id AND rs.active=true
       WHERE pu.auth_provider=$1 AND pu.auth_subject=$2 AND tm.status='active'
       LIMIT 1`,
      [identity.issuer, identity.subject, tenantId],
    )
    if (!result.rows[0] || !['owner', 'admin', 'staff'].includes(result.rows[0].membership_role)) {
      fail(403, 'restaurant_membership_required')
    }
    const row = result.rows[0]
    if (row.membership_role === 'staff' && !row.staff_id) fail(403, 'restaurant_staff_profile_required')
    return {
      userId: row.user_id,
      staffId: row.staff_id,
      role: row.membership_role === 'staff' ? row.staff_role : 'owner',
    }
  })
}

function requireRole(actor, allowed) {
  if (!allowed.includes(actor.role)) fail(403, 'restaurant_role_forbidden')
}

async function loadMenu(client, tenantId, objectStorage = null) {
  const profile = await client.query(
    'SELECT display_name, currency_code, timezone, default_language, tax_mode, tax_rate, gst_rate, tax_inclusive, accepting_orders FROM restaurant_profiles WHERE tenant_id=$1',
    [tenantId],
  )
  const categories = await client.query(
    'SELECT id, name, sort_order, station FROM restaurant_menu_categories WHERE tenant_id=$1 AND active=true ORDER BY sort_order, id',
    [tenantId],
  )
  const items = await client.query(
    `SELECT id, category_id, name, description, base_price_minor, food_type, photo_object_key,
       prep_minutes, priority, available, stock_tracking, stock_quantity, sort_order
     FROM restaurant_menu_items
     WHERE tenant_id=$1 AND active=true
       AND EXISTS (SELECT 1 FROM restaurant_menu_categories c WHERE c.tenant_id=$1 AND c.id=category_id AND c.active=true)
     ORDER BY sort_order, priority DESC, id`,
    [tenantId],
  )
  const variants = await client.query(
    `SELECT v.id, v.item_id, v.name, v.price_minor, v.available, v.sort_order
     FROM restaurant_menu_variants v
     JOIN restaurant_menu_items i ON i.tenant_id=v.tenant_id AND i.id=v.item_id
     WHERE v.tenant_id=$1 AND v.active=true AND i.active=true
     ORDER BY v.sort_order, v.id`,
    [tenantId],
  )
  const addonGroups = await client.query(
    `SELECT g.id, g.name, g.required, g.min_pick, g.max_pick, l.item_id,
       COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'price_minor', a.price_minor, 'available', a.available, 'sort_order', a.sort_order)
         ORDER BY a.sort_order, a.id) FILTER (WHERE a.id IS NOT NULL), '[]'::jsonb) AS addons
     FROM restaurant_addon_groups g
     JOIN restaurant_item_addon_groups l ON l.tenant_id=g.tenant_id AND l.group_id=g.id
     LEFT JOIN restaurant_addons a ON a.tenant_id=g.tenant_id AND a.group_id=g.id AND a.active=true
     WHERE g.tenant_id=$1 AND g.active=true
     GROUP BY g.id, l.item_id
     ORDER BY g.sort_order, g.id`,
    [tenantId],
  )
  const variantsByItem = new Map()
  for (const variant of variants.rows) {
    const list = variantsByItem.get(variant.item_id) ?? []
    list.push(variant)
    variantsByItem.set(variant.item_id, list)
  }
  const groupsByItem = new Map()
  for (const group of addonGroups.rows) {
    const list = groupsByItem.get(group.item_id) ?? []
    list.push({ id: group.id, name: group.name, required: group.required, min_pick: group.min_pick, max_pick: group.max_pick, addons: group.addons })
    groupsByItem.set(group.item_id, list)
  }
  const itemsByCategory = new Map()
  for (const item of items.rows) {
    const list = itemsByCategory.get(item.category_id) ?? []
    list.push({
      ...item,
      photo_url: objectStorage && item.photo_object_key
        ? new URL(createPresignedObjectUrl(objectStorage, { method: 'GET', key: item.photo_object_key, expiresSeconds: 300 })).href
        : null,
      variants: variantsByItem.get(item.id) ?? [],
      addon_groups: groupsByItem.get(item.id) ?? [],
    })
    itemsByCategory.set(item.category_id, list)
  }
  return {
    restaurant: profile.rows[0] ?? null,
    categories: categories.rows.map(category => ({
      ...category,
      items: itemsByCategory.get(category.id) ?? [],
    })),
  }
}

export async function handleRestaurantRoutes(request, response, {
  database = null,
  authenticateIdentity = null,
  objectStorage = null,
} = {}) {
  const pathname = new URL(request.url, 'http://localhost').pathname
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] !== 'restaurant' || parts.length < 3) return false
  if (!database) {
    send(response, 503, { error: 'database_not_configured' })
    return true
  }

  const slug = parts[1]
  let tenantId
  try {
    tenantId = await resolveTenant(database, slug)
  } catch (error) {
    send(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'restaurant_lookup_failed' })
    return true
  }

  if (parts[2] === 'guest' && parts.length === 5 && parts[4] === 'orders') {
    return handleGuestOrder(request, response, { database, tenantId, token: parts[3] })
  }

  if (parts[2] === 'guest' && (
    (parts[4] === 'orders' && parts.length >= 6) ||
    (parts[4] === 'requests' && parts.length === 5) ||
    (parts[4] === 'reviews' && parts.length === 5)
  )) {
    return handleGuestLifecycle(request, response, { database, tenantId, token: parts[3], parts })
  }

  // QR guest access is limited to a high-entropy table token. The raw token
  // is never stored and is returned only once when a table is created.
  if (parts[2] === 'guest' && parts.length === 5 && parts[4] === 'menu' && request.method === 'GET') {
    const token = parts[3]
    if (!TOKEN.test(token)) {
      send(response, 404, { error: 'qr_not_found' })
      return true
    }
    try {
      const result = await withTenantTransaction(database, tenantId, async client => {
        const hash = createHash('sha256').update(token).digest('hex')
        const table = await client.query(
          'SELECT id, label, table_type FROM restaurant_tables WHERE tenant_id=$1 AND public_token_hash=$2 AND active=true',
          [tenantId, hash],
        )
        if (!table.rows[0]) return null
        const menu = await loadMenu(client, tenantId, objectStorage)
        const session = await client.query(
          "SELECT id, status FROM restaurant_table_sessions WHERE tenant_id=$1 AND table_id=$2 AND status='open' LIMIT 1",
          [tenantId, table.rows[0].id],
        )
        return { table: table.rows[0], session: session.rows[0] ?? null, ...menu }
      })
      if (!result) send(response, 404, { error: 'qr_not_found' })
      else send(response, 200, result)
    } catch {
      send(response, 500, { error: 'restaurant_menu_unavailable' })
    }
    return true
  }

  if (!authenticateIdentity) {
    send(response, 503, { error: 'identity_auth_not_configured' })
    return true
  }
  let identity
  try {
    identity = await authenticateIdentity(request)
  } catch (error) {
    send(response, error.statusCode === 403 ? 403 : 401, { error: error.statusCode === 403 ? 'forbidden' : 'unauthorized' })
    return true
  }

  let actor
  try {
    actor = await authenticateTenant(database, tenantId, identity)
  } catch (error) {
    send(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'restaurant_access_failed' })
    return true
  }

  if (parts[2] === 'data-export' && parts.length >= 3) {
    return handleRestaurantDataExport(request, response, { database, tenantId, actor, parts })
  }

  if (parts[2] === 'daily-summary' && parts.length === 3) {
    return handleRestaurantDailySummary(request, response, { database, tenantId, actor, url: new URL(request.url, 'http://localhost') })
  }

  if (parts[2] === 'reports' && parts.length === 3) {
    return handleRestaurantReports(request, response, { database, tenantId, actor, url: new URL(request.url, 'http://localhost') })
  }

  if (parts[2] === 'settings' && parts.length === 3) {
    return handleRestaurantSettings(request, response, { database, tenantId, actor })
  }

  if (parts[2] === 'menu') {
    return handleOwnerMenuRoutes(request, response, { database, tenantId, actor, parts, objectStorage })
  }

  if (parts[2] === 'kitchen') {
    return handleKitchenRoutes(request, response, { database, tenantId, actor, parts })
  }

  if (parts[2] === 'waiter' && parts[3] === 'sessions' && parts.length === 6 && parts[5] === 'invoice') {
    return handleRestaurantInvoice(request, response, { database, tenantId, actor, sessionId: parts[4] })
  }

  if (parts[2] === 'waiter') {
    return handleWaiterRoutes(request, response, { database, tenantId, actor, parts })
  }

  if (parts[2] === 'tables' && parts.length === 3 && request.method === 'GET') {
    try {
      requireRole(actor, ['owner', 'manager', 'waiter'])
      const result = await withTenantTransaction(database, tenantId, client => client.query(
        `SELECT t.id, t.table_number, t.label, t.table_type, t.active,
           s.id AS session_id, s.opened_at, s.guest_count,
           (SELECT count(*)::int FROM restaurant_service_requests r WHERE r.tenant_id=t.tenant_id AND r.table_id=t.id AND r.status='open') AS open_requests
         FROM restaurant_tables t
         LEFT JOIN restaurant_table_sessions s ON s.tenant_id=t.tenant_id AND s.table_id=t.id AND s.status='open'
         WHERE t.tenant_id=$1
         ORDER BY t.table_type, t.table_number NULLS LAST, t.label`,
        [tenantId],
      ))
      send(response, 200, { tables: result.rows })
    } catch (error) {
      send(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'table_list_failed' })
    }
    return true
  }

  if (parts[2] === 'tables' && parts.length === 3 && request.method === 'POST') {
    try {
      requireRole(actor, ['owner', 'manager'])
      const body = await readBody(request)
      const label = typeof body.label === 'string' ? body.label.trim() : ''
      const tableType = body.table_type ?? 'dine_in'
      const tableNumber = body.table_number ?? null
      if (!label || label.length > 80 || !['dine_in', 'takeaway'].includes(tableType) ||
          (tableNumber !== null && (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 9999)) ||
          (tableType === 'takeaway' && tableNumber !== null)) {
        fail(400, 'invalid_table')
      }
      const token = randomBytes(32).toString('base64url')
      const hash = createHash('sha256').update(token).digest('hex')
      const result = await withTenantTransaction(database, tenantId, client => client.query(
        `INSERT INTO restaurant_tables(tenant_id, table_number, label, table_type, public_token_hash)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, table_number, label, table_type, active`,
        [tenantId, tableNumber, label, tableType, hash],
      ))
      send(response, 201, { table: result.rows[0], qr_token: token })
    } catch (error) {
      const status = error.statusCode || (error.code === '23505' ? 409 : 500)
      send(response, status, { error: error.statusCode ? error.message : status === 409 ? 'table_number_exists' : 'table_create_failed' })
    }
    return true
  }

  if (parts[2] === 'tables' && parts.length === 5 && parts[4] === 'sessions' && request.method === 'POST') {
    const tableId = parts[3]
    if (!UUID.test(tableId)) {
      send(response, 404, { error: 'table_not_found' })
      return true
    }
    try {
      requireRole(actor, ['owner', 'manager', 'waiter'])
      const body = await readBody(request)
      const guestCount = body.guest_count ?? null
      if (guestCount !== null && (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 100)) fail(400, 'invalid_guest_count')
      const result = await withTenantTransaction(database, tenantId, async client => {
        const table = await client.query('SELECT id FROM restaurant_tables WHERE tenant_id=$1 AND id=$2 AND active=true', [tenantId, tableId])
        if (!table.rows[0]) fail(404, 'table_not_found')
        return client.query(
          `INSERT INTO restaurant_table_sessions(tenant_id, table_id, guest_count, opened_by)
           VALUES ($1,$2,$3,$4) RETURNING id, table_id, status, guest_count, opened_at`,
          [tenantId, tableId, guestCount, actor.staffId],
        )
      })
      send(response, 201, { session: result.rows[0] })
    } catch (error) {
      const status = error.statusCode || (error.code === '23505' ? 409 : 500)
      send(response, status, { error: error.statusCode ? error.message : status === 409 ? 'table_session_already_open' : 'table_session_open_failed' })
    }
    return true
  }

  if (parts[2] === 'tables' && parts.length === 7 && parts[4] === 'sessions' && parts[6] === 'close' && request.method === 'POST') {
    const tableId = parts[3]
    const sessionId = parts[5]
    if (!UUID.test(tableId) || !UUID.test(sessionId)) {
      send(response, 404, { error: 'session_not_found' })
      return true
    }
    try {
      requireRole(actor, ['owner', 'manager', 'waiter'])
      const result = await withTenantTransaction(database, tenantId, async client => {
        const session = await client.query(
          "SELECT id FROM restaurant_table_sessions WHERE tenant_id=$1 AND table_id=$2 AND id=$3 AND status='open' FOR UPDATE",
          [tenantId, tableId, sessionId],
        )
        if (!session.rows[0]) fail(404, 'session_not_found')
        const outstanding = await client.query(
          `SELECT
             COALESCE((SELECT sum(total_minor) FROM restaurant_orders WHERE tenant_id=$1 AND session_id=$2 AND status <> 'cancelled'),0) AS total_due,
             COALESCE((SELECT sum(amount_minor) FROM restaurant_payments WHERE tenant_id=$1 AND session_id=$2),0) AS paid,
             COALESCE((SELECT sum(amount_minor) FROM restaurant_refunds WHERE tenant_id=$1 AND session_id=$2 AND was_paid=true),0) AS paid_refunds,\n             COALESCE((SELECT sum(amount_minor) FROM restaurant_refunds WHERE tenant_id=$1 AND session_id=$2 AND was_paid=false),0) AS waived,
             EXISTS(SELECT 1 FROM restaurant_orders WHERE tenant_id=$1 AND session_id=$2 AND status NOT IN ('served','cancelled')) AS unfinished`,
          [tenantId, sessionId],
        )
        const totals = outstanding.rows[0]
        if (totals.unfinished) fail(409, 'orders_not_completed')
        if (BigInt(totals.paid) - BigInt(totals.paid_refunds) < BigInt(totals.total_due) - BigInt(totals.waived)) fail(409, 'payment_due')
        return client.query(
          `UPDATE restaurant_table_sessions SET status='closed', closed_at=now(), closed_by=$4, close_reason='staff'
           WHERE tenant_id=$1 AND table_id=$2 AND id=$3 AND status='open'
           RETURNING id, status, closed_at`,
          [tenantId, tableId, sessionId, actor.staffId],
        )
      })
      send(response, 200, { session: result.rows[0] })
    } catch (error) {
      send(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'table_session_close_failed' })
    }
    return true
  }

  send(response, 404, { error: 'restaurant_route_not_found' })
  return true
}
