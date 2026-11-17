import { withTenantTransaction } from '../db/pool.mjs'
import { computeBatchStatus, computeOrderStatus } from './kitchen.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{40,48}$/

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function fail(statusCode, code) {
  const error = new Error(code)
  error.statusCode = statusCode
  throw error
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 8192) fail(413, 'payload_too_large')
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request')
    return body
  } catch (error) {
    if (error.statusCode) throw error
    fail(400, 'invalid_request')
  }
}

async function updateOrderStatus(client, tenantId, orderId) {
  const rows = await client.query(
    'SELECT status FROM restaurant_order_items WHERE tenant_id=$1 AND order_id=$2',
    [tenantId, orderId],
  )
  const status = computeOrderStatus(rows.rows.map(row => row.status))
  await client.query(
    `UPDATE restaurant_orders SET status=$3,
       served_at=CASE WHEN $3='served' THEN COALESCE(served_at,now()) ELSE served_at END
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, orderId, status],
  )
  return status
}

async function updateBatchStatus(client, tenantId, batchId) {
  const rows = await client.query(
    'SELECT status FROM restaurant_batch_allocations WHERE tenant_id=$1 AND batch_id=$2',
    [tenantId, batchId],
  )
  const status = computeBatchStatus(rows.rows.map(row => row.status))
  await client.query(
    `UPDATE restaurant_kitchen_batches SET status=$3,
       completed_at=CASE WHEN $3='completed' THEN COALESCE(completed_at,now()) ELSE completed_at END
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, batchId, status],
  )
  return status
}

async function guestTable(client, tenantId, token) {
  if (!TOKEN.test(token)) return null
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256').update(token).digest('hex')
  const result = await client.query(
    'SELECT id,label FROM restaurant_tables WHERE tenant_id=$1 AND public_token_hash=$2 AND active=true',
    [tenantId, hash],
  )
  return result.rows[0] ?? null
}

export async function handleGuestLifecycle(request, response, { database, tenantId, token, parts }) {
  if (!TOKEN.test(token)) {
    send(response, 404, { error: 'qr_not_found' })
    return true
  }

  try {
    if (parts[4] === 'orders' && parts.length === 6 && request.method === 'GET') {
      const result = await withTenantTransaction(database, tenantId, async client => {
        const table = await guestTable(client, tenantId, token)
        if (!table) fail(404, 'qr_not_found')
        if (!UUID.test(parts[5])) fail(404, 'order_not_found')
        const order = await client.query(
          `SELECT id,order_number,status,subtotal_minor,tax_minor,total_minor,
             special_instructions,created_at,ready_at,served_at
           FROM restaurant_orders WHERE tenant_id=$1 AND table_id=$2 AND id=$3`,
          [tenantId, table.id, parts[5]],
        )
        if (!order.rows[0]) fail(404, 'order_not_found')
        const items = await client.query(
          `SELECT id,item_name_snapshot,variant_name_snapshot,addons_snapshot,
             customization,quantity,unit_price_minor,addons_price_minor,line_total_minor,status,
             ready_at,served_at,unavailable_reason
           FROM restaurant_order_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at,id`,
          [tenantId, parts[5]],
        )
        return { order: order.rows[0], items: items.rows }
      })
      send(response, 200, result)
      return true
    }

    if (parts[4] === 'orders' && parts.length === 7 && parts[6] === 'cancel' && request.method === 'POST') {
      const body = await readBody(request)
      if (!UUID.test(parts[5]) || !UUID.test(body.session_id || '')) fail(400, 'invalid_cancel_request')
      const result = await withTenantTransaction(database, tenantId, async client => {
        const table = await guestTable(client, tenantId, token)
        if (!table) fail(404, 'qr_not_found')
        const session = await client.query(
          "SELECT id FROM restaurant_table_sessions WHERE tenant_id=$1 AND table_id=$2 AND id=$3 AND status='open'",
          [tenantId, table.id, body.session_id],
        )
        if (!session.rows[0]) fail(409, 'table_session_not_open')
        const order = await client.query(
          'SELECT id FROM restaurant_orders WHERE tenant_id=$1 AND table_id=$2 AND session_id=$3 AND id=$4',
          [tenantId, table.id, body.session_id, parts[5]],
        )
        if (!order.rows[0]) fail(404, 'order_not_found')
        const itemId = body.order_item_id ?? null
        let item = null
        if (itemId !== null) {
          if (!UUID.test(itemId)) fail(400, 'invalid_order_item')
          const selected = await client.query(
            'SELECT id,status FROM restaurant_order_items WHERE tenant_id=$1 AND order_id=$2 AND id=$3 FOR UPDATE',
            [tenantId, parts[5], itemId],
          )
          item = selected.rows[0]
          if (!item) fail(404, 'order_item_not_found')
          if (!['new', 'accepted'].includes(item.status)) fail(409, 'cancellation_window_closed')
        } else {
          const preparing = await client.query(
            "SELECT count(*)::int AS count FROM restaurant_order_items WHERE tenant_id=$1 AND order_id=$2 AND status IN ('preparing','ready','served')",
            [tenantId, parts[5]],
          )
          if (Number(preparing.rows[0].count) > 0) fail(409, 'cancellation_window_closed')
        }
        const requestResult = await client.query(
          `INSERT INTO restaurant_service_requests
           (tenant_id,session_id,table_id,request_type,note,order_id,order_item_id)
           VALUES ($1,$2,$3,'cancel_order',$4,$5,$6) RETURNING id,status,created_at`,
          [tenantId, body.session_id, table.id, 'Customer requested order cancellation', parts[5], itemId],
        )
        return requestResult.rows[0]
      })
      send(response, 201, { request: result })
      return true
    }

    if (parts[4] === 'requests' && parts.length === 5 && request.method === 'POST') {
      const body = await readBody(request)
      const requestType = body.request_type
      if (!UUID.test(body.session_id || '') || !['call_waiter', 'need_water', 'request_bill', 'other'].includes(requestType)) {
        fail(400, 'invalid_service_request')
      }
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 250) : ''
      const result = await withTenantTransaction(database, tenantId, async client => {
        const table = await guestTable(client, tenantId, token)
        if (!table) fail(404, 'qr_not_found')
        const session = await client.query(
          "SELECT id FROM restaurant_table_sessions WHERE tenant_id=$1 AND table_id=$2 AND id=$3 AND status='open'",
          [tenantId, table.id, body.session_id],
        )
        if (!session.rows[0]) fail(409, 'table_session_not_open')
        const inserted = await client.query(
          `INSERT INTO restaurant_service_requests(tenant_id,session_id,table_id,request_type,note)
           VALUES ($1,$2,$3,$4,$5) RETURNING id,status,created_at`,
          [tenantId, body.session_id, table.id, requestType, note],
        )
        return inserted.rows[0]
      })
      send(response, 201, { request: result })
      return true
    }

    if (parts[4] === 'reviews' && parts.length === 5 && request.method === 'GET') {
      const eligibility = await withTenantTransaction(database, tenantId, async client => {
        const table = await guestTable(client, tenantId, token)
        if (!table) fail(404, 'qr_not_found')
        const result = await client.query(
          `SELECT s.id,s.closed_at,(r.id IS NOT NULL) AS already_reviewed
           FROM restaurant_table_sessions s
           LEFT JOIN restaurant_reviews r ON r.tenant_id=s.tenant_id AND r.session_id=s.id
           WHERE s.tenant_id=$1 AND s.table_id=$2 AND s.status='closed'
             AND s.closed_at >= now() - interval '30 days'
           ORDER BY s.closed_at DESC LIMIT 1`,
          [tenantId, table.id],
        )
        const row = result.rows[0]
        return { review_session: row && !row.already_reviewed ? { id: row.id, closed_at: row.closed_at } : null,
          already_reviewed: Boolean(row?.already_reviewed) }
      })
      send(response, 200, eligibility)
      return true
    }

    if (parts[4] === 'reviews' && parts.length === 5 && request.method === 'POST') {
      const body = await readBody(request)
      const rating = Number(body.rating)
      if (!UUID.test(body.session_id || '') || !Number.isInteger(rating) || rating < 1 || rating > 5) fail(400, 'invalid_review')
      const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 1000) : ''
      const result = await withTenantTransaction(database, tenantId, async client => {
        const table = await guestTable(client, tenantId, token)
        if (!table) fail(404, 'qr_not_found')
        const session = await client.query(
          "SELECT id FROM restaurant_table_sessions WHERE tenant_id=$1 AND table_id=$2 AND id=$3 AND status='closed'",
          [tenantId, table.id, body.session_id],
        )
        if (!session.rows[0]) fail(409, 'review_available_after_session_close')
        const inserted = await client.query(
          `INSERT INTO restaurant_reviews(tenant_id,session_id,table_id,rating,comment)
           VALUES ($1,$2,$3,$4,$5) RETURNING id,rating,comment,created_at`,
          [tenantId, body.session_id, table.id, rating, comment],
        )
        return inserted.rows[0]
      })
      send(response, 201, { review: result })
      return true
    }
  } catch (error) {
    const status = error.statusCode || (error.code === '23505' ? 409 : 500)
    send(response, status, { error: error.statusCode ? error.message : status === 409 ? 'duplicate_or_conflicting_request' : 'guest_request_failed' })
    return true
  }
  send(response, 404, { error: 'guest_route_not_found' })
  return true
}

export async function handleWaiterRoutes(request, response, { database, tenantId, actor, parts }) {



  try {
    if (!['owner', 'manager', 'waiter'].includes(actor.role)) fail(403, 'restaurant_role_forbidden')

    if (parts[3] === 'sessions' && parts.length === 6 && parts[5] === 'bill' && request.method === 'GET') {
      const sessionId = parts[4]
      if (!UUID.test(sessionId)) fail(404, 'table_session_not_found')
      const bill = await withTenantTransaction(database, tenantId, async client => {
        const session = await client.query(
          `SELECT s.id,s.opened_at,s.closed_at,s.guest_count,t.label AS table_label,
             p.display_name AS restaurant_name,p.currency_code
           FROM restaurant_table_sessions s
           JOIN restaurant_tables t ON t.tenant_id=s.tenant_id AND t.id=s.table_id
           LEFT JOIN restaurant_profiles p ON p.tenant_id=s.tenant_id
           WHERE s.tenant_id=$1 AND s.id=$2`,
          [tenantId, sessionId],
        )
        if (!session.rows[0]) fail(404, 'table_session_not_found')
        const orders = await client.query(
          `SELECT id,order_number,status,subtotal_minor,tax_minor,total_minor,created_at
           FROM restaurant_orders WHERE tenant_id=$1 AND session_id=$2 AND status <> 'cancelled'
           ORDER BY created_at,id`,
          [tenantId, sessionId],
        )
        const items = await client.query(
          `SELECT oi.order_id,oi.item_name_snapshot,oi.variant_name_snapshot,oi.addons_snapshot,
             oi.quantity,oi.unit_price_minor,oi.addons_price_minor,oi.line_total_minor,oi.status
           FROM restaurant_order_items oi
           JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id
           WHERE oi.tenant_id=$1 AND o.session_id=$2 AND o.status <> 'cancelled'
           ORDER BY oi.created_at,oi.id`,
          [tenantId, sessionId],
        )
        const payments = await client.query(
          'SELECT amount_minor,method,reference,paid_at FROM restaurant_payments WHERE tenant_id=$1 AND session_id=$2 ORDER BY paid_at,id',
          [tenantId, sessionId],
        )
        const refunds = await client.query(
          'SELECT amount_minor,reason,was_paid,created_at FROM restaurant_refunds WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at,id',
          [tenantId, sessionId],
        )
        const invoice = await client.query(
          'SELECT invoice_number,financial_year,issued_at,seller_snapshot,items_snapshot,subtotal_minor,tax_minor,cgst_minor,sgst_minor,igst_minor,other_tax_minor,total_minor,tax_rate,tax_inclusive FROM restaurant_invoices WHERE tenant_id=$1 AND session_id=$2',
          [tenantId, sessionId],
        )
        return { session: session.rows[0], orders: orders.rows, items: items.rows,
          payments: payments.rows, refunds: refunds.rows, invoice: invoice.rows[0] ?? null }
      })
      send(response, 200, bill)
      return true
    }

    if (parts[3] === 'board' && parts.length === 4 && request.method === 'GET') {
      const result = await withTenantTransaction(database, tenantId, async client => {
        const tables = await client.query(
          `SELECT t.id,t.table_number,t.label,t.table_type,s.id AS session_id,s.opened_at,s.guest_count,
             (SELECT count(*)::int FROM restaurant_order_items oi JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id
              WHERE oi.tenant_id=t.tenant_id AND o.session_id=s.id AND oi.status='ready') AS ready_items,
             (SELECT count(*)::int FROM restaurant_service_requests r WHERE r.tenant_id=t.tenant_id AND r.session_id=s.id AND r.status='open') AS open_requests,
             COALESCE((SELECT sum(o.total_minor) FROM restaurant_orders o WHERE o.tenant_id=t.tenant_id AND o.session_id=s.id AND o.status <> 'cancelled'),0)::text AS total_due_minor,
             COALESCE((SELECT sum(p.amount_minor) FROM restaurant_payments p WHERE p.tenant_id=t.tenant_id AND p.session_id=s.id),0)::text AS paid_minor,
             COALESCE((SELECT sum(r.amount_minor) FROM restaurant_refunds r WHERE r.tenant_id=t.tenant_id AND r.session_id=s.id AND r.was_paid=true),0)::text AS refunded_minor,\n             COALESCE((SELECT sum(r.amount_minor) FROM restaurant_refunds r WHERE r.tenant_id=t.tenant_id AND r.session_id=s.id AND r.was_paid=false),0)::text AS waived_minor
           FROM restaurant_tables t
           LEFT JOIN restaurant_table_sessions s ON s.tenant_id=t.tenant_id AND s.table_id=t.id AND s.status='open'
           WHERE t.tenant_id=$1 AND t.active=true
           ORDER BY t.table_type,t.table_number NULLS LAST,t.label`,
          [tenantId],
        )
        const ready = await client.query(
          `SELECT oi.id AS order_item_id,oi.order_id,oi.item_name_snapshot,oi.variant_name_snapshot,
             oi.addons_snapshot,oi.customization,oi.quantity,o.order_number,o.session_id,t.id AS table_id,t.label AS table_label
           FROM restaurant_order_items oi
           JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id
           JOIN restaurant_tables t ON t.tenant_id=o.tenant_id AND t.id=o.table_id
           WHERE oi.tenant_id=$1 AND oi.status='ready'
           ORDER BY oi.ready_at,o.order_number`,
          [tenantId],
        )
        const requests = await client.query(
          `SELECT r.id,r.session_id,r.table_id,r.request_type,r.note,r.created_at,t.label AS table_label
           FROM restaurant_service_requests r
           JOIN restaurant_tables t ON t.tenant_id=r.tenant_id AND t.id=r.table_id
           WHERE r.tenant_id=$1 AND r.status='open'
           ORDER BY r.created_at`,
          [tenantId],
        )
        return { tables: tables.rows, ready_items: ready.rows, service_requests: requests.rows }
      })
      send(response, 200, result)
      return true
    }

    if (parts[3] === 'items' && parts.length === 6 && parts[5] === 'serve' && request.method === 'POST') {
      const itemId = parts[4]
      if (!UUID.test(itemId)) fail(404, 'order_item_not_found')
      const result = await withTenantTransaction(database, tenantId, async client => {
        const found = await client.query(
          `SELECT oi.id,oi.order_id,a.batch_id FROM restaurant_order_items oi
           JOIN restaurant_batch_allocations a ON a.tenant_id=oi.tenant_id AND a.order_item_id=oi.id
           WHERE oi.tenant_id=$1 AND oi.id=$2 AND oi.status='ready'
           FOR UPDATE OF oi,a`,
          [tenantId, itemId],
        )
        if (!found.rows[0]) fail(409, 'item_not_ready_or_not_found')
        await client.query(
          "UPDATE restaurant_order_items SET status='served',served_at=now() WHERE tenant_id=$1 AND id=$2",
          [tenantId, itemId],
        )
        await client.query(
          "UPDATE restaurant_batch_allocations SET status='served',served_at=now() WHERE tenant_id=$1 AND order_item_id=$2",
          [tenantId, itemId],
        )
        const batchStatus = await updateBatchStatus(client, tenantId, found.rows[0].batch_id)
        const orderStatus = await updateOrderStatus(client, tenantId, found.rows[0].order_id)
        await client.query(
          `INSERT INTO restaurant_activity_events(tenant_id,actor_staff_id,action,detail)
           VALUES ($1,$2,'waiter.item_served',jsonb_build_object('order_item_id',$3))`,
          [tenantId, actor.staffId, itemId],
        )
        return { batch_status: batchStatus, order_status: orderStatus, order_id: found.rows[0].order_id }
      })
      send(response, 200, { item: { id: itemId, status: 'served' }, ...result })
      return true
    }

    if (parts[3] === 'requests' && parts.length === 5 && request.method === 'PATCH') {
      const requestId = parts[4]
      if (!UUID.test(requestId)) fail(404, 'service_request_not_found')
      const body = await readBody(request)
      if (!['handled', 'dismissed'].includes(body.status)) fail(400, 'invalid_request_status')
      const result = await withTenantTransaction(database, tenantId, client => client.query(
        `UPDATE restaurant_service_requests
         SET status=$3,handled_by=$4,handled_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='open'
         RETURNING id,status,handled_at`,
        [tenantId, requestId, body.status, actor.staffId],
      ))
      if (!result.rows[0]) fail(404, 'service_request_not_found')
      send(response, 200, { request: result.rows[0] })
      return true
    }

    if (parts[3] === 'sessions' && parts.length === 6 && parts[5] === 'payments' && request.method === 'POST') {
      const sessionId = parts[4]
      if (!UUID.test(sessionId)) fail(404, 'table_session_not_found')
      const body = await readBody(request)
      if (!/^\d{1,15}$/.test(String(body.amount_minor ?? '')) || !['cash', 'upi', 'card', 'other'].includes(body.method)) {
        fail(400, 'invalid_payment')
      }
      const amount = BigInt(body.amount_minor)
      if (amount <= 0n) fail(400, 'invalid_payment')
      const reference = typeof body.reference === 'string' ? body.reference.trim().slice(0, 120) : null
      const result = await withTenantTransaction(database, tenantId, async client => {
        const session = await client.query(
          "SELECT id,table_id FROM restaurant_table_sessions WHERE tenant_id=$1 AND id=$2 AND status='open' FOR UPDATE",
          [tenantId, sessionId],
        )
        if (!session.rows[0]) fail(404, 'table_session_not_found')
        const totals = await client.query(
          `SELECT
             COALESCE((SELECT sum(total_minor) FROM restaurant_orders WHERE tenant_id=$1 AND session_id=$2 AND status <> 'cancelled'),0)::text AS total_due,
             COALESCE((SELECT sum(amount_minor) FROM restaurant_payments WHERE tenant_id=$1 AND session_id=$2),0)::text AS paid,
             COALESCE((SELECT sum(amount_minor) FROM restaurant_refunds WHERE tenant_id=$1 AND session_id=$2 AND was_paid=true),0)::text AS refunded,\n             COALESCE((SELECT sum(amount_minor) FROM restaurant_refunds WHERE tenant_id=$1 AND session_id=$2 AND was_paid=false),0)::text AS waived`,
          [tenantId, sessionId],
        )
        const row = totals.rows[0]
        const balance = BigInt(row.total_due) - BigInt(row.paid) + BigInt(row.refunded) - BigInt(row.waived)
        if (amount > balance) fail(409, 'payment_exceeds_balance')
        const payment = await client.query(
          `INSERT INTO restaurant_payments(tenant_id,session_id,table_id,amount_minor,method,reference,confirmed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id,amount_minor,method,reference,paid_at`,
          [tenantId, sessionId, session.rows[0].table_id, String(amount), body.method, reference, actor.staffId],
        )
        return { payment: payment.rows[0], balance_minor: String(balance - amount) }
      })
      send(response, 201, result)
      return true
    }
  } catch (error) {
    const status = error.statusCode || (error.code === '23505' ? 409 : 500)
    send(response, status, { error: error.statusCode ? error.message : status === 409 ? 'request_conflict' : 'waiter_operation_failed' })
    return true
  }

  send(response, 404, { error: 'waiter_route_not_found' })
  return true
}
