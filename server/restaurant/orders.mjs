import { createHash } from 'node:crypto'
import { withTenantTransaction } from '../db/pool.mjs'

const TOKEN = /^[A-Za-z0-9_-]{40,48}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/

function fail(statusCode, code, extra = {}) {
  const error = new Error(code)
  error.statusCode = statusCode
  error.extra = extra
  throw error
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 16 * 1024) fail(413, 'payload_too_large')
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_order')
    return value
  } catch (error) {
    if (error.statusCode) throw error
    fail(400, 'invalid_order')
  }
}

function localized(value) {
  if (typeof value === 'string') return value
  return value?.en || value?.hi || value?.kn || 'Item'
}

function normalizeCustomization(value) {
  return String(value || '').toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f\u0c80-\u0cff ]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

export function calculateTaxMinor(subtotalMinor, mode, rateValue, inclusive) {
  const subtotal = BigInt(subtotalMinor)
  const rateBasisPoints = BigInt(Math.round((Number(rateValue) || 0) * 10000))
  if (!['single', 'gst'].includes(mode) || rateBasisPoints <= 0n) return { tax: 0n, total: subtotal }
  const numerator = subtotal * rateBasisPoints
  const denominator = inclusive ? 1000000n + rateBasisPoints : 1000000n
  const tax = (numerator + denominator / 2n) / denominator
  return { tax, total: inclusive ? subtotal : subtotal + tax }
}

async function getItem(client, tenantId, line) {
  const result = await client.query(
    `SELECT i.id, i.category_id, i.name, i.base_price_minor, i.food_type, i.available,
       i.stock_tracking, i.stock_quantity, i.active, c.active AS category_active
     FROM restaurant_menu_items i
     JOIN restaurant_menu_categories c ON c.tenant_id=i.tenant_id AND c.id=i.category_id
     WHERE i.tenant_id=$1 AND i.id=$2
     FOR UPDATE OF i`,
    [tenantId, line.item_id],
  )
  return result.rows[0] ?? null
}

async function prepareLine(client, tenantId, line) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) fail(400, 'invalid_order_line')
  if (typeof line.item_id !== 'string' || !UUID.test(line.item_id)) fail(400, 'invalid_order_line')
  const quantity = Number(line.quantity)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) fail(400, 'invalid_quantity')

  const item = await getItem(client, tenantId, line)
  if (!item || !item.active || !item.category_active || !item.available) {
    return { removed: { item_id: line.item_id, reason: 'unavailable', name: item ? localized(item.name) : 'Item' } }
  }

  const variantResult = await client.query(
    'SELECT id, name, price_minor, available FROM restaurant_menu_variants WHERE tenant_id=$1 AND item_id=$2 AND active=true ORDER BY sort_order,id',
    [tenantId, item.id],
  )
  let variant = null
  if (variantResult.rows.length) {
    variant = variantResult.rows.find(row => row.id === line.variant_id)
    if (!variant) fail(400, 'variant_required')
    if (!variant.available) return { removed: { item_id: item.id, reason: 'variant_unavailable', name: localized(item.name) } }
  } else if (line.variant_id) {
    fail(400, 'invalid_variant')
  }

  const groupsResult = await client.query(
    `SELECT g.id AS group_id, g.name AS group_name, g.required, g.min_pick, g.max_pick,
       a.id AS addon_id, a.name AS addon_name, a.price_minor AS addon_price_minor, a.available AS addon_available
     FROM restaurant_item_addon_groups l
     JOIN restaurant_addon_groups g ON g.tenant_id=l.tenant_id AND g.id=l.group_id AND g.active=true
     LEFT JOIN restaurant_addons a ON a.tenant_id=g.tenant_id AND a.group_id=g.id AND a.active=true
     WHERE l.tenant_id=$1 AND l.item_id=$2
     ORDER BY g.sort_order,g.id,a.sort_order,a.id`,
    [tenantId, item.id],
  )
  const groups = new Map()
  for (const row of groupsResult.rows) {
    if (!groups.has(row.group_id)) groups.set(row.group_id, {
      id: row.group_id, required: row.required, min: row.min_pick, max: row.max_pick, addons: new Map(),
    })
    if (row.addon_id) groups.get(row.group_id).addons.set(row.addon_id, row)
  }

  if (line.addon_ids !== undefined && !Array.isArray(line.addon_ids)) fail(400, 'invalid_addons')
  const selectedIds = Array.isArray(line.addon_ids) ? [...new Set(line.addon_ids)] : []
  if (selectedIds.some(id => typeof id !== 'string' || !UUID.test(id))) fail(400, 'invalid_addons')
  const selected = []
  const counts = new Map()
  for (const addonId of selectedIds) {
    let found = null
    for (const group of groups.values()) {
      if (group.addons.has(addonId)) {
        found = { group, addon: group.addons.get(addonId) }
        break
      }
    }
    if (!found) fail(400, 'invalid_addon')
    if (!found.addon.addon_available) {
      return { removed: { item_id: item.id, reason: 'addon_unavailable', name: localized(item.name) } }
    }
    selected.push(found.addon)
    counts.set(found.group.id, (counts.get(found.group.id) || 0) + 1)
  }
  for (const group of groups.values()) {
    const count = counts.get(group.id) || 0
    const minimum = group.required ? Math.max(1, Number(group.min)) : Number(group.min)
    if (count < minimum || count > Number(group.max)) fail(400, 'invalid_addon_selection')
  }

  const unitPrice = BigInt(variant?.price_minor ?? item.base_price_minor)
  const addonPrice = selected.reduce((sum, addon) => sum + BigInt(addon.addon_price_minor), 0n)
  const customization = typeof line.customization === 'string' ? line.customization.replace(/\s+/g, ' ').trim().slice(0, 100) : ''
  return {
    item,
    variant,
    quantity,
    unitPrice,
    addonPrice,
    customization,
    customizationKey: normalizeCustomization(customization),
    addonSnapshot: selected.map(addon => ({
      id: addon.addon_id,
      name: addon.addon_name,
      price_minor: String(addon.addon_price_minor),
    })),
    lineTotal: BigInt(quantity) * (unitPrice + addonPrice),
  }
}

export async function handleGuestOrder(request, response, { database, tenantId, token }) {
  if (!TOKEN.test(token)) {
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: 'qr_not_found' }))
    return true
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    response.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: 'method_not_allowed' }))
    return true
  }

  try {
    const body = await readBody(request)
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) fail(400, 'invalid_order_items')
    if (typeof body.session_id !== 'string' || !UUID.test(body.session_id)) fail(400, 'table_session_required')
    if (typeof body.idempotency_key !== 'string' || !IDEMPOTENCY_KEY.test(body.idempotency_key)) fail(400, 'invalid_idempotency_key')
    const note = typeof body.note === 'string' ? body.note.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    const tokenHash = createHash('sha256').update(token).digest('hex')

    const result = await withTenantTransaction(database, tenantId, async client => {
      const tableResult = await client.query(
        'SELECT id,label FROM restaurant_tables WHERE tenant_id=$1 AND public_token_hash=$2 AND active=true FOR UPDATE',
        [tenantId, tokenHash],
      )
      const table = tableResult.rows[0]
      if (!table) fail(404, 'qr_not_found')

      const sessionResult = await client.query(
        `SELECT id FROM restaurant_table_sessions
         WHERE tenant_id=$1 AND table_id=$2 AND id=$3 AND status='open'
         FOR UPDATE`,
        [tenantId, table.id, body.session_id],
      )
      if (!sessionResult.rows[0]) fail(409, 'table_session_not_open')

      const duplicate = await client.query(
        'SELECT id, order_number, subtotal_minor, tax_minor, total_minor, status FROM restaurant_orders WHERE tenant_id=$1 AND session_id=$2 AND idempotency_key=$3',
        [tenantId, body.session_id, body.idempotency_key],
      )
      if (duplicate.rows[0]) return { duplicate: true, order: duplicate.rows[0], removed: [] }

      const profileResult = await client.query(
        'SELECT accepting_orders,tax_mode,tax_rate,gst_rate,tax_inclusive FROM restaurant_profiles WHERE tenant_id=$1 FOR UPDATE',
        [tenantId],
      )
      const profile = profileResult.rows[0] ?? { accepting_orders: true, tax_mode: 'none', tax_rate: 0, gst_rate: 0, tax_inclusive: false }
      if (!profile.accepting_orders) fail(409, 'restaurant_not_accepting_orders')

      const rate = await client.query(
        `SELECT count(*)::int AS recent_count FROM restaurant_orders
         WHERE tenant_id=$1 AND session_id=$2 AND created_at > now() - interval '10 minutes'`,
        [tenantId, body.session_id],
      )
      if (Number(rate.rows[0]?.recent_count || 0) >= 5) fail(429, 'order_rate_limited')

      const prepared = []
      const removed = []
      for (const line of body.items) {
        const item = await prepareLine(client, tenantId, line)
        if (item.removed) removed.push(item.removed)
        else prepared.push(item)
      }

      const demand = new Map()
      for (const line of prepared) {
        if (line.item.stock_tracking) {
          demand.set(line.item.id, (demand.get(line.item.id) || 0) + line.quantity)
        }
      }
      for (const [itemId, quantity] of demand) {
        const line = prepared.find(entry => entry.item.id === itemId)
        if (line.item.stock_quantity === null || Number(line.item.stock_quantity) < quantity) {
          removed.push({ item_id: itemId, reason: 'insufficient_stock', name: localized(line.item.name) })
        }
      }
      const rejected = new Set(removed.filter(entry => entry.reason === 'insufficient_stock').map(entry => entry.item_id))
      const accepted = prepared.filter(line => !rejected.has(line.item.id))
      if (!accepted.length) fail(409, 'no_orderable_items', { removed })

      const subtotal = accepted.reduce((sum, line) => sum + line.lineTotal, 0n)
      const taxMode = profile.tax_mode
      const taxRate = taxMode === 'gst' ? profile.gst_rate : profile.tax_rate
      const tax = calculateTaxMinor(subtotal, taxMode, taxRate, profile.tax_inclusive)
      if (tax.total > 9000000000000000n) fail(400, 'order_total_too_large')

      // Serialize the per-tenant order number allocation and all stock decrements.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tenantId])
      const sequence = await client.query(
        'SELECT COALESCE(MAX(order_number),0)::text AS last_number FROM restaurant_orders WHERE tenant_id=$1',
        [tenantId],
      )
      const orderNumber = BigInt(sequence.rows[0].last_number) + 1n
      const order = await client.query(
        `INSERT INTO restaurant_orders
         (tenant_id,order_number,table_id,session_id,status,subtotal_minor,tax_minor,total_minor,special_instructions,source,idempotency_key,tax_mode_snapshot,tax_rate_snapshot,tax_inclusive_snapshot)
         VALUES ($1,$2,$3,$4,'new',$5,$6,$7,$8,'qr',$9,$10,$11,$12)
         RETURNING id,order_number,status,subtotal_minor,tax_minor,total_minor,created_at`,
        [tenantId, String(orderNumber), table.id, body.session_id, String(subtotal), String(tax.tax), String(tax.total), note, body.idempotency_key, taxMode, Number(taxRate) || 0, Boolean(profile.tax_inclusive)],
      )
      const createdOrder = order.rows[0]

      const stockRemaining = new Map()
      for (const line of accepted) {
        const itemName = localized(line.item.name)
        const variantName = line.variant ? localized(line.variant.name) : null
        const inserted = await client.query(
          `INSERT INTO restaurant_order_items
           (tenant_id,order_id,item_id,variant_id,category_id,item_name_snapshot,variant_name_snapshot,
            addons_snapshot,customization,customization_key,quantity,unit_price_minor,addons_price_minor,line_total_minor,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,'new')
           RETURNING id`,
          [tenantId, createdOrder.id, line.item.id, line.variant?.id ?? null, line.item.category_id,
            itemName, variantName, JSON.stringify(line.addonSnapshot), line.customization, line.customizationKey,
            line.quantity, String(line.unitPrice), String(line.addonPrice), String(line.lineTotal)],
        )
        if (line.item.stock_tracking) {
          const oldQuantity = stockRemaining.has(line.item.id)
            ? stockRemaining.get(line.item.id)
            : line.item.stock_quantity
          const stock = await client.query(
            `UPDATE restaurant_menu_items SET stock_quantity=stock_quantity-$3,updated_at=now()
             WHERE tenant_id=$1 AND id=$2
             RETURNING stock_quantity`,
            [tenantId, line.item.id, line.quantity],
          )
          const newQuantity = stock.rows[0].stock_quantity
          stockRemaining.set(line.item.id, newQuantity)
          await client.query(
            `INSERT INTO restaurant_stock_events(tenant_id,item_id,quantity_delta,old_quantity,new_quantity,reason)
             VALUES ($1,$2,$3,$4,$5,'order')`,
            [tenantId, line.item.id, -line.quantity, oldQuantity, newQuantity],
          )
        }
        const baseBatchKey = createHash('sha256')
          .update(JSON.stringify([line.item.id, line.variant?.id ?? null, line.addonSnapshot.map(a => a.id).sort(), line.customizationKey]))
          .digest('hex')
        const existingBatch = await client.query(
          'SELECT id,status FROM restaurant_kitchen_batches WHERE tenant_id=$1 AND batch_key=$2 FOR UPDATE',
          [tenantId, baseBatchKey],
        )
        let batchId
        if (existingBatch.rows[0]?.status === 'new') {
          const updatedBatch = await client.query(
            'UPDATE restaurant_kitchen_batches SET total_quantity=total_quantity+$3 WHERE tenant_id=$1 AND id=$2 RETURNING id',
            [tenantId, existingBatch.rows[0].id, line.quantity],
          )
          batchId = updatedBatch.rows[0]?.id
        } else {
          const uniqueBatchKey = existingBatch.rows[0] ? baseBatchKey + ':' + inserted.rows[0].id : baseBatchKey
          const newBatch = await client.query(
            `INSERT INTO restaurant_kitchen_batches
             (tenant_id,batch_key,item_name_snapshot,variant_name_snapshot,addons_snapshot,customization_key,total_quantity,status)
             VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'new') RETURNING id`,
            [tenantId, uniqueBatchKey, itemName, variantName, JSON.stringify(line.addonSnapshot), line.customizationKey, line.quantity],
          )
          batchId = newBatch.rows[0]?.id
        }
        if (!batchId) fail(500, 'kitchen_batch_create_failed')
        await client.query(
          `INSERT INTO restaurant_batch_allocations(tenant_id,batch_id,order_item_id,quantity,status)
           VALUES ($1,$2,$3,$4,'new')`,
          [tenantId, batchId, inserted.rows[0].id, line.quantity],
        )
      }

      if (removed.length) {
        await client.query(
          `INSERT INTO restaurant_service_requests(tenant_id,session_id,table_id,request_type,note)
           VALUES ($1,$2,$3,'other',$4)`,
          [tenantId, body.session_id, table.id, 'Some unavailable items were removed from the submitted cart'],
        )
      }
      return { duplicate: false, order: createdOrder, removed }
    })

    response.writeHead(result.duplicate ? 200 : 201, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(result))
  } catch (error) {
    const status = error.statusCode || 500
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({
      error: error.statusCode ? error.message : 'order_placement_failed',
      ...(error.extra || {}),
    }))
  }
  return true
}
