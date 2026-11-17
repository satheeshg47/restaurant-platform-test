import type { Env } from './types.ts'

type Actor = { tenantId: string; userId: string; staffId: string | null; role: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
const fail = (status: number, code: string): never => { throw Object.assign(new Error(code), { status }) }
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

async function body(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > 8192) fail(413, 'payload_too_large')
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request')
    return value as Record<string, unknown>
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error
    fail(400, 'invalid_request')
  }
}

function orderStatus(statuses: string[]) {
  const active = statuses.filter(s => !['unavailable','cancelled'].includes(s))
  let status = !active.length ? 'cancelled'
    : active.every(s => s === 'served') ? 'served'
    : active.every(s => ['ready','served'].includes(s)) ? 'ready'
    : active.some(s => ['preparing','ready','served'].includes(s)) ? 'preparing'
    : active.some(s => s === 'accepted') ? 'accepted' : 'new'
  if (!['served','cancelled'].includes(status) && statuses.includes('unavailable')) status = 'partially_unavailable'
  return status
}
function batchStatus(statuses: string[]) {
  if (statuses.length && statuses.every(s => ['served','unavailable','cancelled'].includes(s))) return 'completed'
  if (statuses.some(s => s === 'preparing')) return 'preparing'
  if (statuses.length && statuses.every(s => ['ready','served','unavailable','cancelled'].includes(s))) return 'ready'
  if (statuses.some(s => s === 'accepted')) return 'accepted'
  return 'new'
}
async function cookScope(env: Env, actor: Actor) {
  if (actor.role !== 'cook' || !actor.staffId) return null
  const rows = await env.DB.prepare("SELECT assignment_value FROM restaurant_staff_assignments WHERE tenant_id=? AND staff_id=? AND assignment_kind='category'").bind(actor.tenantId,actor.staffId).all<{assignment_value:string}>()
  return rows.results.map(r => r.assignment_value)
}
async function refreshOrder(env: Env, tenantId: string, orderId: string) {
  const rows = await env.DB.prepare('SELECT status FROM restaurant_order_items WHERE tenant_id=? AND order_id=?').bind(tenantId,orderId).all<{status:string}>()
  const status = orderStatus(rows.results.map(r=>r.status))
  await env.DB.prepare(`UPDATE restaurant_orders SET status=?,accepted_at=CASE WHEN ? IN ('accepted','preparing','ready','served','partially_unavailable') THEN COALESCE(accepted_at,${now}) ELSE accepted_at END,preparation_started_at=CASE WHEN ? IN ('preparing','ready','served','partially_unavailable') THEN COALESCE(preparation_started_at,${now}) ELSE preparation_started_at END,ready_at=CASE WHEN ? IN ('ready','served') THEN COALESCE(ready_at,${now}) ELSE ready_at END,served_at=CASE WHEN ?='served' THEN COALESCE(served_at,${now}) ELSE served_at END WHERE tenant_id=? AND id=?`).bind(status,status,status,status,status,tenantId,orderId).run()
  return status
}
async function refreshBatch(env: Env, tenantId: string, batchId: string, staffId: string|null) {
  const rows = await env.DB.prepare('SELECT status FROM restaurant_batch_allocations WHERE tenant_id=? AND batch_id=?').bind(tenantId,batchId).all<{status:string}>()
  const status = batchStatus(rows.results.map(r=>r.status))
  await env.DB.prepare(`UPDATE restaurant_kitchen_batches SET status=?,claimed_by=COALESCE(claimed_by,?),preparing_at=CASE WHEN ? IN ('preparing','ready','completed') THEN COALESCE(preparing_at,${now}) ELSE preparing_at END,completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,${now}) ELSE completed_at END WHERE tenant_id=? AND id=?`).bind(status,staffId,status,status,tenantId,batchId).run()
  return status
}
async function queue(env: Env, actor: Actor) {
  const result = await env.DB.prepare(`SELECT b.id AS batch_id,b.batch_key,b.status AS batch_status,b.item_name_snapshot,b.variant_name_snapshot,b.addons_snapshot,b.total_quantity,b.created_at AS batch_created_at,b.claimed_by,a.id AS allocation_id,a.quantity AS allocation_quantity,a.status AS allocation_status,oi.id AS order_item_id,oi.order_id,oi.category_id,oi.customization,oi.status AS item_status,oi.accepted_by,oi.preparation_started_at,oi.ready_at,o.order_number,o.special_instructions,o.created_at AS order_created_at,t.id AS table_id,t.label AS table_label FROM restaurant_kitchen_batches b JOIN restaurant_batch_allocations a ON a.tenant_id=b.tenant_id AND a.batch_id=b.id JOIN restaurant_order_items oi ON oi.tenant_id=a.tenant_id AND oi.id=a.order_item_id JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id JOIN restaurant_tables t ON t.tenant_id=o.tenant_id AND t.id=o.table_id WHERE b.tenant_id=? AND b.status IN ('new','accepted','preparing','ready') AND oi.status IN ('new','accepted','preparing','ready') ORDER BY b.created_at,o.order_number,oi.created_at`).bind(actor.tenantId).all<Record<string,unknown>>()
  const scope = await cookScope(env,actor)
  return scope?.length ? result.results.filter(r=>scope.includes(String(r.category_id))) : result.results
}
async function kitchenStatus(request: Request, env: Env, actor: Actor, itemId: string) {
  if (!UUID.test(itemId)) fail(404,'order_item_not_found')
  const input = await body(request)
  const target = input.status
  if (!['accepted','preparing','ready','unavailable'].includes(String(target))) fail(400,'invalid_kitchen_status')
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0,250) : ''
  if (target === 'unavailable' && !reason) fail(400,'unavailable_reason_required')
  const found = await env.DB.prepare(`SELECT oi.id,oi.order_id,oi.category_id,oi.status,oi.accepted_by,a.batch_id,o.session_id,o.table_id FROM restaurant_order_items oi JOIN restaurant_batch_allocations a ON a.tenant_id=oi.tenant_id AND a.order_item_id=oi.id JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id WHERE oi.tenant_id=? AND oi.id=?`).bind(actor.tenantId,itemId).first<Record<string,unknown>>()
  if (!found) throw Object.assign(new Error('order_item_not_found'), { status: 404 })
  if (actor.role === 'cook') {
    const scope = await cookScope(env,actor)
    if (scope?.length && !scope.includes(String(found.category_id))) fail(403,'cook_station_forbidden')
    if (['preparing','ready','unavailable'].includes(String(target)) && found.accepted_by && found.accepted_by !== actor.staffId) fail(409,'item_claimed_by_another_cook')
  }
  const transitions: Record<string,string[]> = { accepted:['new'], preparing:['accepted'], ready:['preparing'], unavailable:['new','accepted','preparing'] }
  if (!transitions[String(target)].includes(String(found.status))) fail(409,'invalid_status_transition')
  if (target === 'accepted') {
    await env.DB.batch([
      env.DB.prepare("UPDATE restaurant_order_items SET status='accepted',accepted_by=? WHERE tenant_id=? AND id=?").bind(actor.staffId,actor.tenantId,itemId),
      env.DB.prepare("UPDATE restaurant_batch_allocations SET status='accepted' WHERE tenant_id=? AND order_item_id=?").bind(actor.tenantId,itemId),
    ])
  } else if (target === 'preparing') {
    await env.DB.batch([
      env.DB.prepare(`UPDATE restaurant_order_items SET status='preparing',preparation_started_at=${now} WHERE tenant_id=? AND id=?`).bind(actor.tenantId,itemId),
      env.DB.prepare("UPDATE restaurant_batch_allocations SET status='preparing' WHERE tenant_id=? AND order_item_id=?").bind(actor.tenantId,itemId),
    ])
  } else if (target === 'ready') {
    await env.DB.batch([
      env.DB.prepare(`UPDATE restaurant_order_items SET status='ready',ready_at=${now} WHERE tenant_id=? AND id=?`).bind(actor.tenantId,itemId),
      env.DB.prepare(`UPDATE restaurant_batch_allocations SET status='ready',ready_at=${now} WHERE tenant_id=? AND order_item_id=?`).bind(actor.tenantId,itemId),
    ])
  } else {
    await env.DB.batch([
      env.DB.prepare(`UPDATE restaurant_order_items SET status='unavailable',unavailable_reason=?,unavailable_at=${now} WHERE tenant_id=? AND id=?`).bind(reason,actor.tenantId,itemId),
      env.DB.prepare("UPDATE restaurant_batch_allocations SET status='unavailable' WHERE tenant_id=? AND order_item_id=?").bind(actor.tenantId,itemId),
      env.DB.prepare("INSERT INTO restaurant_service_requests(tenant_id,session_id,table_id,request_type,note,order_id,order_item_id) VALUES(?,?,?,'other',?,?,?)").bind(actor.tenantId,found.session_id,found.table_id,'Kitchen marked item unavailable: '+reason,found.order_id,itemId),
    ])
  }
  const [bStatus,oStatus] = await Promise.all([refreshBatch(env,actor.tenantId,String(found.batch_id),actor.staffId),refreshOrder(env,actor.tenantId,String(found.order_id))])
  return { item:{id:itemId,status:target,order_id:found.order_id},batch_status:bStatus,order_status:oStatus }
}
async function waiterBoard(env: Env, actor: Actor) {
  const tables = await env.DB.prepare(`SELECT t.id,t.table_number,t.label,t.table_type,s.id AS session_id,s.opened_at,s.guest_count,(SELECT count(*) FROM restaurant_order_items oi JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id WHERE oi.tenant_id=t.tenant_id AND o.session_id=s.id AND oi.status='ready') AS ready_items,(SELECT count(*) FROM restaurant_service_requests r WHERE r.tenant_id=t.tenant_id AND r.session_id=s.id AND r.status='open') AS open_requests,COALESCE((SELECT sum(o.total_minor) FROM restaurant_orders o WHERE o.tenant_id=t.tenant_id AND o.session_id=s.id AND o.status<>'cancelled'),0) AS total_due_minor,COALESCE((SELECT sum(p.amount_minor) FROM restaurant_payments p WHERE p.tenant_id=t.tenant_id AND p.session_id=s.id),0) AS paid_minor,COALESCE((SELECT sum(r.amount_minor) FROM restaurant_refunds r WHERE r.tenant_id=t.tenant_id AND r.session_id=s.id AND r.was_paid=1),0) AS refunded_minor FROM restaurant_tables t LEFT JOIN restaurant_table_sessions s ON s.tenant_id=t.tenant_id AND s.table_id=t.id AND s.status='open' WHERE t.tenant_id=? AND t.active=1 ORDER BY t.table_type,t.table_number,t.label`).bind(actor.tenantId).all()
  const ready = await env.DB.prepare(`SELECT oi.id AS order_item_id,oi.order_id,oi.item_name_snapshot,oi.variant_name_snapshot,oi.addons_snapshot,oi.customization,oi.quantity,o.order_number,o.session_id,t.id AS table_id,t.label AS table_label FROM restaurant_order_items oi JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id JOIN restaurant_tables t ON t.tenant_id=o.tenant_id AND t.id=o.table_id WHERE oi.tenant_id=? AND oi.status='ready' ORDER BY oi.ready_at,o.order_number`).bind(actor.tenantId).all()
  const requests = await env.DB.prepare(`SELECT r.id,r.session_id,r.table_id,r.request_type,r.note,r.created_at,t.label AS table_label FROM restaurant_service_requests r JOIN restaurant_tables t ON t.tenant_id=r.tenant_id AND t.id=r.table_id WHERE r.tenant_id=? AND r.status='open' ORDER BY r.created_at`).bind(actor.tenantId).all()
  return { tables:tables.results,ready_items:ready.results,service_requests:requests.results }
}
async function serveItem(env: Env, actor: Actor, itemId: string) {
  if (!UUID.test(itemId)) fail(404,'order_item_not_found')
  const found = await env.DB.prepare("SELECT oi.id,oi.order_id,a.batch_id FROM restaurant_order_items oi JOIN restaurant_batch_allocations a ON a.tenant_id=oi.tenant_id AND a.order_item_id=oi.id WHERE oi.tenant_id=? AND oi.id=? AND oi.status='ready'").bind(actor.tenantId,itemId).first<Record<string,string>>()
  if (!found) throw Object.assign(new Error('item_not_ready_or_not_found'), { status: 409 })
  await env.DB.batch([
    env.DB.prepare(`UPDATE restaurant_order_items SET status='served',served_at=${now} WHERE tenant_id=? AND id=? AND status='ready'`).bind(actor.tenantId,itemId),
    env.DB.prepare(`UPDATE restaurant_batch_allocations SET status='served',served_at=${now} WHERE tenant_id=? AND order_item_id=? AND status='ready'`).bind(actor.tenantId,itemId),
  ])
  const [bStatus,oStatus] = await Promise.all([refreshBatch(env,actor.tenantId,found.batch_id,actor.staffId),refreshOrder(env,actor.tenantId,found.order_id)])
  return { item:{id:itemId,status:'served',order_id:found.order_id},batch_status:bStatus,order_status:oStatus }
}
async function waiterBill(env: Env, actor: Actor, sessionId: string) {
  if (!UUID.test(sessionId)) fail(404,'table_session_not_found')
  const session = await env.DB.prepare(`SELECT s.id,s.opened_at,s.closed_at,s.guest_count,t.label AS table_label,p.display_name AS restaurant_name,p.currency_code FROM restaurant_table_sessions s JOIN restaurant_tables t ON t.tenant_id=s.tenant_id AND t.id=s.table_id LEFT JOIN restaurant_profiles p ON p.tenant_id=s.tenant_id WHERE s.tenant_id=? AND s.id=?`).bind(actor.tenantId,sessionId).first()
  if (!session) throw Object.assign(new Error('table_session_not_found'), { status: 404 })
  const [orders,items,payments,refunds,invoice] = await Promise.all([
    env.DB.prepare("SELECT id,order_number,status,subtotal_minor,tax_minor,total_minor,created_at FROM restaurant_orders WHERE tenant_id=? AND session_id=? AND status<>'cancelled' ORDER BY created_at,id").bind(actor.tenantId,sessionId).all(),
    env.DB.prepare("SELECT oi.order_id,oi.item_name_snapshot,oi.variant_name_snapshot,oi.addons_snapshot,oi.quantity,oi.unit_price_minor,oi.addons_price_minor,oi.line_total_minor,oi.status FROM restaurant_order_items oi JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id WHERE oi.tenant_id=? AND o.session_id=? AND o.status<>'cancelled' ORDER BY oi.created_at,oi.id").bind(actor.tenantId,sessionId).all(),
    env.DB.prepare("SELECT amount_minor,method,reference,paid_at FROM restaurant_payments WHERE tenant_id=? AND session_id=? ORDER BY paid_at,id").bind(actor.tenantId,sessionId).all(),
    env.DB.prepare("SELECT amount_minor,reason,was_paid,created_at FROM restaurant_refunds WHERE tenant_id=? AND session_id=? ORDER BY created_at,id").bind(actor.tenantId,sessionId).all(),
    env.DB.prepare("SELECT invoice_number,financial_year,issued_at,seller_snapshot,items_snapshot,subtotal_minor,tax_minor,cgst_minor,sgst_minor,igst_minor,other_tax_minor,total_minor,tax_rate,tax_inclusive FROM restaurant_invoices WHERE tenant_id=? AND session_id=?").bind(actor.tenantId,sessionId).first(),
  ])
  return {session,orders:orders.results,items:items.results,payments:payments.results,refunds:refunds.results,invoice:invoice??null}
}
async function recordPayment(request: Request, env: Env, actor: Actor, sessionId: string) {
  if (!UUID.test(sessionId)) fail(404,'table_session_not_found')
  const input = await body(request)
  if (!/^\d{1,15}$/.test(String(input.amount_minor ?? '')) || !['cash','upi','card','other'].includes(String(input.method))) fail(400,'invalid_payment')
  const amount = BigInt(String(input.amount_minor))
  if (amount <= 0n) fail(400,'invalid_payment')
  const reference = typeof input.reference === 'string' ? input.reference.trim().slice(0,120) : null
  const session = await env.DB.prepare("SELECT id,table_id FROM restaurant_table_sessions WHERE tenant_id=? AND id=? AND status='open'").bind(actor.tenantId,sessionId).first<{id:string;table_id:string}>()
  if (!session) fail(404,'table_session_not_found')
  const totals = await env.DB.prepare(`SELECT COALESCE((SELECT sum(total_minor) FROM restaurant_orders WHERE tenant_id=? AND session_id=? AND status<>'cancelled'),0) AS due,COALESCE((SELECT sum(amount_minor) FROM restaurant_payments WHERE tenant_id=? AND session_id=?),0) AS paid,COALESCE((SELECT sum(amount_minor) FROM restaurant_refunds WHERE tenant_id=? AND session_id=? AND was_paid=1),0) AS refunded,COALESCE((SELECT sum(amount_minor) FROM restaurant_refunds WHERE tenant_id=? AND session_id=? AND was_paid=0),0) AS waived`).bind(actor.tenantId,sessionId,actor.tenantId,sessionId,actor.tenantId,sessionId,actor.tenantId,sessionId).first<Record<string,number>>()
  const balance = BigInt(totals?.due||0)-BigInt(totals?.paid||0)+BigInt(totals?.refunded||0)-BigInt(totals?.waived||0)
  if (amount > balance) fail(409,'payment_exceeds_balance')
  const payment = await env.DB.prepare('INSERT INTO restaurant_payments(tenant_id,session_id,table_id,amount_minor,method,reference,confirmed_by) VALUES(?,?,?,?,?,?,?) RETURNING id,amount_minor,method,reference,paid_at').bind(actor.tenantId,sessionId,session.table_id,String(amount),input.method,reference,actor.staffId).first()
  return {payment,balance_minor:String(balance-amount)}
}
async function recordRefund(request: Request, env: Env, actor: Actor, sessionId: string) {
  if (!UUID.test(sessionId)) fail(404,'table_session_not_found')
  const input = await body(request)
  if (!/^\d{1,15}$/.test(String(input.amount_minor ?? '')) || typeof input.order_id !== 'string' || !UUID.test(input.order_id)) fail(400,'invalid_refund')
  const amount = BigInt(String(input.amount_minor))
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  const wasPaid = input.was_paid === true
  const itemId = input.order_item_id ?? null
  if (amount<=0n || !reason || reason.length>250 || (itemId!==null && (typeof itemId!=='string' || !UUID.test(itemId)))) fail(400,'invalid_refund')
  const session = await env.DB.prepare("SELECT id FROM restaurant_table_sessions WHERE tenant_id=? AND id=? AND status='open'").bind(actor.tenantId,sessionId).first()
  if (!session) fail(404,'table_session_not_found')
  const order = await env.DB.prepare("SELECT id FROM restaurant_orders WHERE tenant_id=? AND session_id=? AND id=? AND status<>'cancelled'").bind(actor.tenantId,sessionId,input.order_id).first()
  if (!order) fail(404,'order_not_found')
  if (itemId) {
    const item = await env.DB.prepare('SELECT id FROM restaurant_order_items WHERE tenant_id=? AND order_id=? AND id=?').bind(actor.tenantId,input.order_id,itemId).first()
    if (!item) fail(404,'order_item_not_found')
  }
  const totals = await env.DB.prepare(`SELECT COALESCE((SELECT sum(total_minor) FROM restaurant_orders WHERE tenant_id=? AND session_id=? AND status<>'cancelled'),0) AS due,COALESCE((SELECT sum(amount_minor) FROM restaurant_payments WHERE tenant_id=? AND session_id=?),0) AS paid,COALESCE((SELECT sum(amount_minor) FROM restaurant_refunds WHERE tenant_id=? AND session_id=? AND was_paid=1),0) AS paid_refunds,COALESCE((SELECT sum(amount_minor) FROM restaurant_refunds WHERE tenant_id=? AND session_id=? AND was_paid=0),0) AS waived`).bind(actor.tenantId,sessionId,actor.tenantId,sessionId,actor.tenantId,sessionId,actor.tenantId,sessionId).first<Record<string,number>>()
  const due=BigInt(totals?.due||0),paid=BigInt(totals?.paid||0),paidRefunds=BigInt(totals?.paid_refunds||0),waived=BigInt(totals?.waived||0)
  const balance=due-paid+paidRefunds-waived
  if (wasPaid ? amount>paid-paidRefunds : amount>(balance>0n?balance:0n)) fail(409,wasPaid?'refund_exceeds_net_paid':'waiver_exceeds_outstanding_balance')
  const refund = await env.DB.prepare('INSERT INTO restaurant_refunds(tenant_id,order_id,order_item_id,session_id,amount_minor,reason,was_paid,created_by) VALUES(?,?,?,?,?,?,?,?) RETURNING id,order_id,order_item_id,session_id,amount_minor,reason,was_paid,created_at').bind(actor.tenantId,input.order_id,itemId,sessionId,String(amount),reason,Number(wasPaid),actor.staffId).first()
  return {refund,balance_minor:String(wasPaid?balance+amount:balance-amount)}
}
async function updateServiceRequest(request: Request, env: Env, actor: Actor, requestId: string) {
  if (!UUID.test(requestId)) fail(404,'service_request_not_found')
  const input = await body(request)
  if (!['handled','dismissed'].includes(String(input.status))) fail(400,'invalid_request_status')
  const result = await env.DB.prepare(`UPDATE restaurant_service_requests SET status=?,handled_by=?,handled_at=${now} WHERE tenant_id=? AND id=? AND status='open' RETURNING id,status,handled_at`).bind(input.status,actor.staffId,actor.tenantId,requestId).all()
  if (!result.results[0]) fail(404,'service_request_not_found')
  return result.results[0]
}
export async function handleOrderOperations(request: Request, env: Env, actor: Actor, parts: string[]) {
  if (parts[2] === 'kitchen' && parts[3] === 'queue' && parts.length === 4 && request.method === 'GET') {
    if (!['owner','manager','cook'].includes(actor.role)) fail(403,'restaurant_role_forbidden')
    return json(200,{queue:await queue(env,actor)})
  }
  if (parts[2] === 'kitchen' && parts[3] === 'items' && parts.length === 6 && parts[5] === 'status' && request.method === 'PATCH') {
    if (!['owner','manager','cook'].includes(actor.role)) fail(403,'restaurant_role_forbidden')
    return json(200,await kitchenStatus(request,env,actor,parts[4]))
  }
  if (parts[2] === 'waiter' && parts[3] === 'sessions' && parts.length === 6 && parts[5] === 'bill' && request.method === 'GET') {
    if (!['owner','manager','waiter'].includes(actor.role)) fail(403,'restaurant_role_forbidden')
    return json(200,await waiterBill(env,actor,parts[4]))
  }
  if (parts[2] === 'waiter' && parts[3] === 'sessions' && parts.length === 6 && parts[5] === 'payments' && request.method === 'POST') {
    if (!['owner','manager','waiter'].includes(actor.role)) fail(403,'restaurant_role_forbidden')
    return json(201,await recordPayment(request,env,actor,parts[4]))
  }
  if (parts[2] === 'waiter' && parts[3] === 'sessions' && parts.length === 6 && parts[5] === 'refunds' && request.method === 'POST') {
    if (!['owner','manager','waiter'].includes(actor.role)) fail(403,'restaurant_role_forbidden')
    return json(201,await recordRefund(request,env,actor,parts[4]))
  }
  if (parts[2] === 'waiter' && parts[3] === 'requests' && parts.length === 5 && request.method === 'PATCH') {
    if (!['owner','manager','waiter'].includes(actor.role)) fail(403,'restaurant_role_forbidden')
    return json(200,{request:await updateServiceRequest(request,env,actor,parts[4])})
  }
  if (parts[2] === 'waiter' && parts[3] === 'board' && parts.length === 4 && request.method === 'GET') {
    if (!['owner','manager','waiter'].includes(actor.role)) fail(403,'restaurant_role_forbidden')
    return json(200,await waiterBoard(env,actor))
  }
  if (parts[2] === 'waiter' && parts[3] === 'items' && parts.length === 6 && parts[5] === 'serve' && request.method === 'POST') {
    if (!['owner','manager','waiter'].includes(actor.role)) fail(403,'restaurant_role_forbidden')
    return json(200,await serveItem(env,actor,parts[4]))
  }
  return null
}
