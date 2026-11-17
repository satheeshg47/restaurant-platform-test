import { withTenantTransaction } from '../db/pool.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

export async function handleRestaurantRefund(request, response, { database, tenantId, actor, parts }) {
  try {
    if (!['owner', 'manager', 'waiter'].includes(actor.role)) fail(403, 'restaurant_role_forbidden')
    if (request.method !== 'POST' || parts.length !== 6 || parts[3] !== 'sessions' || parts[5] !== 'refunds') return false
    const sessionId = parts[4]
    if (!UUID.test(sessionId)) fail(404, 'table_session_not_found')
    const body = await readBody(request)
    if (!/^\d{1,15}$/.test(String(body.amount_minor ?? '')) || !UUID.test(body.order_id || '')) fail(400, 'invalid_refund')
    const amount = BigInt(body.amount_minor)
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    const wasPaid = body.was_paid === true
    const orderItemId = body.order_item_id ?? null
    if (amount <= 0n || !reason || reason.length > 250 || (orderItemId !== null && !UUID.test(orderItemId))) fail(400, 'invalid_refund')
    const result = await withTenantTransaction(database, tenantId, async client => {
      const session = await client.query(
        "SELECT id FROM restaurant_table_sessions WHERE tenant_id=$1 AND id=$2 AND status='open' FOR UPDATE",
        [tenantId, sessionId],
      )
      if (!session.rows[0]) fail(404, 'table_session_not_found')
      const order = await client.query(
        "SELECT id,total_minor FROM restaurant_orders WHERE tenant_id=$1 AND session_id=$2 AND id=$3 AND status <> 'cancelled' FOR UPDATE",
        [tenantId, sessionId, body.order_id],
      )
      if (!order.rows[0]) fail(404, 'order_not_found')
      if (orderItemId) {
        const item = await client.query(
          'SELECT id FROM restaurant_order_items WHERE tenant_id=$1 AND order_id=$2 AND id=$3',
          [tenantId, body.order_id, orderItemId],
        )
        if (!item.rows[0]) fail(404, 'order_item_not_found')
      }
      const totals = await client.query(
        `SELECT
          COALESCE((SELECT sum(total_minor) FROM restaurant_orders WHERE tenant_id=$1 AND session_id=$2 AND status <> 'cancelled'),0)::text AS due,
          COALESCE((SELECT sum(amount_minor) FROM restaurant_payments WHERE tenant_id=$1 AND session_id=$2),0)::text AS paid,
          COALESCE((SELECT sum(amount_minor) FROM restaurant_refunds WHERE tenant_id=$1 AND session_id=$2 AND was_paid=true),0)::text AS paid_refunds,
          COALESCE((SELECT sum(amount_minor) FROM restaurant_refunds WHERE tenant_id=$1 AND session_id=$2 AND was_paid=false),0)::text AS waived`,
        [tenantId, sessionId],
      )
      const row = totals.rows[0]
      const due = BigInt(row.due)
      const paid = BigInt(row.paid)
      const paidRefunds = BigInt(row.paid_refunds)
      const waived = BigInt(row.waived)
      const balance = due - paid + paidRefunds - waived
      if (wasPaid) {
        if (amount > paid - paidRefunds) fail(409, 'refund_exceeds_net_paid')
      } else if (amount > (balance > 0n ? balance : 0n)) {
        fail(409, 'waiver_exceeds_outstanding_balance')
      }
      const inserted = await client.query(
        `INSERT INTO restaurant_refunds
         (tenant_id,order_id,order_item_id,session_id,amount_minor,reason,was_paid,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id,order_id,order_item_id,session_id,amount_minor,reason,was_paid,created_at`,
        [tenantId, body.order_id, orderItemId, sessionId, String(amount), reason, wasPaid, actor.staffId],
      )
      const nextBalance = wasPaid ? balance + amount : balance - amount
      await client.query(
        `INSERT INTO restaurant_activity_events(tenant_id,actor_staff_id,action,detail)
         VALUES ($1,$2,'waiter.refund_recorded',jsonb_build_object('refund_id',$3,'order_id',$4,'amount_minor',$5,'was_paid',$6))`,
        [tenantId, actor.staffId, inserted.rows[0].id, body.order_id, String(amount), wasPaid],
      )
      return { refund: inserted.rows[0], balance_minor: String(nextBalance) }
    })
    send(response, 201, result)
  } catch (error) {
    const status = error.statusCode || (error.code === '23505' ? 409 : 500)
    send(response, status, { error: error.statusCode ? error.message : status === 409 ? 'request_conflict' : 'restaurant_refund_failed' })
  }
  return true
}
