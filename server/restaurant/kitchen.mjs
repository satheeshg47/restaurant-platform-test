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

export function computeOrderStatus(statuses) {
  const active = statuses.filter(status => !['unavailable', 'cancelled'].includes(status))
  let status = 'new'
  if (!active.length) status = 'cancelled'
  else if (active.every(value => value === 'served')) status = 'served'
  else if (active.every(value => ['ready', 'served'].includes(value))) status = 'ready'
  else if (active.some(value => ['preparing', 'ready', 'served'].includes(value))) status = 'preparing'
  else if (active.some(value => value === 'accepted')) status = 'accepted'
  if (status !== 'served' && status !== 'cancelled' && statuses.some(value => value === 'unavailable')) {
    status = 'partially_unavailable'
  }
  return status
}

export function computeBatchStatus(statuses) {
  if (statuses.length && statuses.every(value => ['served', 'unavailable', 'cancelled'].includes(value))) return 'completed'
  if (statuses.some(value => value === 'preparing')) return 'preparing'
  if (statuses.length && statuses.every(value => ['ready', 'served', 'unavailable', 'cancelled'].includes(value))) return 'ready'
  if (statuses.some(value => value === 'accepted')) return 'accepted'
  return 'new'
}

async function cookScope(client, tenantId, actor) {
  if (actor.role !== 'cook') return null
  const result = await client.query(
    "SELECT assignment_value FROM restaurant_staff_assignments WHERE tenant_id=$1 AND staff_id=$2 AND assignment_kind='category'",
    [tenantId, actor.staffId],
  )
  return result.rows.map(row => row.assignment_value)
}

async function loadQueue(client, tenantId, actor) {
  const scope = await cookScope(client, tenantId, actor)
  const result = await client.query(
    `SELECT b.id AS batch_id,b.batch_key,b.status AS batch_status,b.item_name_snapshot,
       b.variant_name_snapshot,b.addons_snapshot,b.total_quantity,b.created_at AS batch_created_at,
       b.claimed_by,a.id AS allocation_id,a.quantity AS allocation_quantity,a.status AS allocation_status,
       oi.id AS order_item_id,oi.order_id,oi.category_id,oi.customization,oi.status AS item_status,
       oi.accepted_by,oi.preparation_started_at,oi.ready_at,
       o.order_number,o.special_instructions,o.created_at AS order_created_at,
       t.id AS table_id,t.label AS table_label
     FROM restaurant_kitchen_batches b
     JOIN restaurant_batch_allocations a ON a.tenant_id=b.tenant_id AND a.batch_id=b.id
     JOIN restaurant_order_items oi ON oi.tenant_id=a.tenant_id AND oi.id=a.order_item_id
     JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id
     JOIN restaurant_tables t ON t.tenant_id=o.tenant_id AND t.id=o.table_id
     WHERE b.tenant_id=$1
       AND b.status IN ('new','accepted','preparing','ready')
       AND oi.status IN ('new','accepted','preparing','ready')
     ORDER BY b.created_at ASC,o.order_number ASC,oi.created_at ASC`,
    [tenantId],
  )
  const rows = scope?.length ? result.rows.filter(row => scope.includes(String(row.category_id))) : result.rows
  return rows
}

async function rollupOrder(client, tenantId, orderId) {
  const result = await client.query(
    'SELECT status FROM restaurant_order_items WHERE tenant_id=$1 AND order_id=$2',
    [tenantId, orderId],
  )
  const statuses = result.rows.map(row => row.status)
  const status = computeOrderStatus(statuses)
  await client.query(
    `UPDATE restaurant_orders
     SET status=$3,
       accepted_at=CASE WHEN $3 IN ('accepted','preparing','ready','served','partially_unavailable') THEN COALESCE(accepted_at,now()) ELSE accepted_at END,
       preparation_started_at=CASE WHEN $3 IN ('preparing','ready','served','partially_unavailable') THEN COALESCE(preparation_started_at,now()) ELSE preparation_started_at END,
       ready_at=CASE WHEN $3 IN ('ready','served') THEN COALESCE(ready_at,now()) ELSE ready_at END,
       served_at=CASE WHEN $3='served' THEN COALESCE(served_at,now()) ELSE served_at END
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, orderId, status],
  )
  return status
}

async function updateBatch(client, tenantId, batchId, staffId) {
  const result = await client.query(
    'SELECT status FROM restaurant_batch_allocations WHERE tenant_id=$1 AND batch_id=$2',
    [tenantId, batchId],
  )
  const statuses = result.rows.map(row => row.status)
  const status = computeBatchStatus(statuses)
  await client.query(
    'UPDATE restaurant_kitchen_batches SET status=$3,claimed_by=COALESCE(claimed_by,$4),preparing_at=CASE WHEN $3 IN (\'preparing\',\'ready\',\'completed\') THEN COALESCE(preparing_at,now()) ELSE preparing_at END,completed_at=CASE WHEN $3=\'completed\' THEN COALESCE(completed_at,now()) ELSE completed_at END WHERE tenant_id=$1 AND id=$2',
    [tenantId, batchId, status, staffId],
  )
  return status
}

export async function handleKitchenRoutes(request, response, { database, tenantId, actor, parts }) {
  if (parts[3] === 'queue' && parts.length === 4 && request.method === 'GET') {
    try {
      if (!['owner', 'manager', 'cook'].includes(actor.role)) fail(403, 'restaurant_role_forbidden')
      const result = await database.connect()
      try {
        await result.query('BEGIN')
        await result.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId])
        const rows = await loadQueue(result, tenantId, actor)
        await result.query('COMMIT')
        send(response, 200, { queue: rows })
      } catch (error) {
        await result.query('ROLLBACK')
        throw error
      } finally {
        result.release()
      }
    } catch (error) {
      send(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'kitchen_queue_failed' })
    }
    return true
  }

  if (parts[3] === 'items' && parts.length === 6 && parts[5] === 'status' && request.method === 'PATCH') {
    const itemId = parts[4]
    if (!UUID.test(itemId)) {
      send(response, 404, { error: 'order_item_not_found' })
      return true
    }
    try {
      if (!['owner', 'manager', 'cook'].includes(actor.role)) fail(403, 'restaurant_role_forbidden')
      const body = await readBody(request)
      const target = body.status
      if (!['accepted', 'preparing', 'ready', 'unavailable'].includes(target)) fail(400, 'invalid_kitchen_status')
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 250) : ''
      if (target === 'unavailable' && !reason) fail(400, 'unavailable_reason_required')

      const client = await database.connect()
      let item
      let orderStatus
      let batchStatus
      try {
        await client.query('BEGIN')
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId])
        const found = await client.query(
          `SELECT oi.id,oi.order_id,oi.category_id,oi.status,oi.accepted_by,a.batch_id
           FROM restaurant_order_items oi
           JOIN restaurant_batch_allocations a ON a.tenant_id=oi.tenant_id AND a.order_item_id=oi.id
           WHERE oi.tenant_id=$1 AND oi.id=$2
           FOR UPDATE OF oi,a`,
          [tenantId, itemId],
        )
        item = found.rows[0]
        if (!item) fail(404, 'order_item_not_found')

        if (actor.role === 'cook') {
          const scope = await cookScope(client, tenantId, actor)
          if (scope?.length && !scope.includes(String(item.category_id))) fail(403, 'cook_station_forbidden')
        }

        const transitions = {
          accepted: ['new'],
          preparing: ['accepted'],
          ready: ['preparing'],
          unavailable: ['new', 'accepted', 'preparing'],
        }
        if (!transitions[target].includes(item.status)) fail(409, 'invalid_status_transition')
        if (['preparing', 'ready', 'unavailable'].includes(target) && item.accepted_by && item.accepted_by !== actor.staffId && actor.role === 'cook') {
          fail(409, 'item_claimed_by_another_cook')
        }
        if (target === 'accepted') {
          await client.query(
            "UPDATE restaurant_order_items SET status='accepted',accepted_by=$3 WHERE tenant_id=$1 AND id=$2",
            [tenantId, itemId, actor.staffId],
          )
          await client.query(
            "UPDATE restaurant_batch_allocations SET status='accepted' WHERE tenant_id=$1 AND order_item_id=$2",
            [tenantId, itemId],
          )
        } else if (target === 'preparing') {
          await client.query(
            "UPDATE restaurant_order_items SET status='preparing',preparation_started_at=now() WHERE tenant_id=$1 AND id=$2",
            [tenantId, itemId],
          )
          await client.query(
            "UPDATE restaurant_batch_allocations SET status='preparing' WHERE tenant_id=$1 AND order_item_id=$2",
            [tenantId, itemId],
          )
        } else if (target === 'ready') {
          await client.query(
            "UPDATE restaurant_order_items SET status='ready',ready_at=now() WHERE tenant_id=$1 AND id=$2",
            [tenantId, itemId],
          )
          await client.query(
            "UPDATE restaurant_batch_allocations SET status='ready',ready_at=now() WHERE tenant_id=$1 AND order_item_id=$2",
            [tenantId, itemId],
          )
        } else {
          await client.query(
            "UPDATE restaurant_order_items SET status='unavailable',unavailable_reason=$3,unavailable_at=now() WHERE tenant_id=$1 AND id=$2",
            [tenantId, itemId, reason],
          )
          await client.query(
            "UPDATE restaurant_batch_allocations SET status='unavailable' WHERE tenant_id=$1 AND order_item_id=$2",
            [tenantId, itemId],
          )
          await client.query(
            `INSERT INTO restaurant_service_requests(tenant_id,session_id,table_id,request_type,note)
             SELECT $1,o.session_id,o.table_id,'other',$3
             FROM restaurant_orders o WHERE o.tenant_id=$1 AND o.id=$2`,
            [tenantId, item.order_id, 'Kitchen marked an item unavailable: ' + reason],
          )
        }
        batchStatus = await updateBatch(client, tenantId, item.batch_id, actor.staffId)
        orderStatus = await rollupOrder(client, tenantId, item.order_id)
        await client.query(
          `INSERT INTO restaurant_activity_events(tenant_id,actor_staff_id,action,detail)
           VALUES ($1,$2,'kitchen.item_status',jsonb_build_object('order_item_id',$3,'status',$4))`,
          [tenantId, actor.staffId, itemId, target],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
      send(response, 200, {
        item: { id: itemId, status: target, order_id: item.order_id },
        order_status: orderStatus,
        batch_status: batchStatus,
      })
    } catch (error) {
      send(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'kitchen_status_update_failed' })
    }
    return true
  }

  send(response, 404, { error: 'kitchen_route_not_found' })
  return true
}
