import { withTenantTransaction } from '../db/pool.mjs'

const DAY = /^\d{4}-\d{2}-\d{2}$/
function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
function fail(statusCode, code) { const error = new Error(code); error.statusCode = statusCode; throw error }
function validDay(value) {
  if (typeof value !== 'string' || !DAY.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
function localToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export async function handleRestaurantDailySummary(request, response, { database, tenantId, actor, url }) {
  try {
    if (!['owner', 'manager'].includes(actor.role)) fail(403, 'restaurant_role_forbidden')
    if (!['GET', 'POST'].includes(request.method)) return false
    const businessDate = url.searchParams.get('date')
    if (!validDay(businessDate) || businessDate > localToday()) fail(400, 'invalid_business_date')
    const result = await withTenantTransaction(database, tenantId, async client => {
      if (request.method === 'GET') {
        const saved = await client.query(
          'SELECT business_date::text,order_count,revenue_minor::text,tax_minor::text,cancelled_count,refunds_minor::text,average_order_minor::text,metrics,updated_at FROM restaurant_daily_summaries WHERE tenant_id=$1 AND business_date=$2::date',
          [tenantId, businessDate],
        )
        return saved.rows[0] ?? null
      }
      const rangeStart = `($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')`
      const rangeEnd = `(($2::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`
      const orders = await client.query(
        `SELECT count(*) FILTER (WHERE status <> 'cancelled')::int AS order_count,
           count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
           COALESCE(sum(total_minor) FILTER (WHERE status <> 'cancelled'),0)::text AS revenue_minor,
           COALESCE(sum(tax_minor) FILTER (WHERE status <> 'cancelled'),0)::text AS tax_minor
         FROM restaurant_orders
         WHERE tenant_id=$1 AND created_at >= ${rangeStart} AND created_at < ${rangeEnd}`,
        [tenantId, businessDate],
      )
      const payments = await client.query(
        `SELECT method, count(*)::int AS payment_count, COALESCE(sum(amount_minor),0)::text AS amount_minor
         FROM restaurant_payments WHERE tenant_id=$1 AND paid_at >= ${rangeStart} AND paid_at < ${rangeEnd}
         GROUP BY method ORDER BY method`,
        [tenantId, businessDate],
      )
      const refunds = await client.query(
        `SELECT count(*)::int AS refund_count, COALESCE(sum(amount_minor),0)::text AS refunds_minor
         FROM restaurant_refunds WHERE tenant_id=$1 AND created_at >= ${rangeStart} AND created_at < ${rangeEnd}`,
        [tenantId, businessDate],
      )
      const topItems = await client.query(
        `SELECT oi.item_name_snapshot, COALESCE(oi.variant_name_snapshot,'') AS variant_name_snapshot,
           sum(oi.quantity)::int AS quantity, COALESCE(sum(oi.line_total_minor),0)::text AS sales_minor
         FROM restaurant_order_items oi
         JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id
         WHERE oi.tenant_id=$1 AND o.created_at >= ${rangeStart} AND o.created_at < ${rangeEnd}
           AND o.status <> 'cancelled' AND oi.status NOT IN ('cancelled','unavailable')
         GROUP BY oi.item_name_snapshot,oi.variant_name_snapshot
         ORDER BY sum(oi.quantity) DESC,sum(oi.line_total_minor) DESC LIMIT 10`,
        [tenantId, businessDate],
      )
      const orderCount = Number(orders.rows[0].order_count || 0)
      const revenue = BigInt(orders.rows[0].revenue_minor || 0)
      const average = orderCount ? (revenue / BigInt(orderCount)).toString() : null
      const metrics = {
        payments: payments.rows,
        refund_count: Number(refunds.rows[0].refund_count || 0),
        top_items: topItems.rows,
      }
      const saved = await client.query(
        `INSERT INTO restaurant_daily_summaries
         (tenant_id,business_date,order_count,revenue_minor,tax_minor,cancelled_count,refunds_minor,average_order_minor,metrics)
         VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (tenant_id,business_date) DO UPDATE SET
           order_count=EXCLUDED.order_count,revenue_minor=EXCLUDED.revenue_minor,
           tax_minor=EXCLUDED.tax_minor,cancelled_count=EXCLUDED.cancelled_count,
           refunds_minor=EXCLUDED.refunds_minor,average_order_minor=EXCLUDED.average_order_minor,
           metrics=EXCLUDED.metrics
         RETURNING business_date::text,order_count,revenue_minor::text,tax_minor::text,
           cancelled_count,refunds_minor::text,average_order_minor::text,metrics,now() AS updated_at`,
        [tenantId, businessDate, orderCount, orders.rows[0].revenue_minor, orders.rows[0].tax_minor,
          Number(orders.rows[0].cancelled_count || 0), refunds.rows[0].refunds_minor, average, JSON.stringify(metrics)],
      )
      return saved.rows[0]
    })
    if (!result) send(response, 404, { error: 'daily_summary_not_found' })
    else send(response, 200, { summary: result, archived: request.method === 'POST' })
    return true
  } catch (error) {
    send(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'restaurant_daily_summary_failed' })
    return true
  }
}
