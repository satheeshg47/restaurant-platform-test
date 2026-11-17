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
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === value
}

export async function handleRestaurantReports(request, response, { database, tenantId, actor, url }) {
  try {
    if (!['owner','manager'].includes(actor.role)) fail(403, 'restaurant_role_forbidden')
    if (request.method !== 'GET') return false
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (!validDay(from) || !validDay(to) || from > to) fail(400, 'invalid_report_date_range')
    const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1
    if (days > 366) fail(400, 'report_range_too_large')
    const report = await withTenantTransaction(database, tenantId, async client => {
      const summary = await client.query(
        `SELECT count(*)::int AS order_count,
           COALESCE(sum(subtotal_minor),0)::text AS subtotal_minor,
           COALESCE(sum(tax_minor),0)::text AS tax_minor,
           COALESCE(sum(total_minor),0)::text AS sales_minor
         FROM restaurant_orders
         WHERE tenant_id=$1 AND status <> 'cancelled'
           AND created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND created_at < (($3::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`,
        [tenantId, from, to],
      )
      const payments = await client.query(
        `SELECT method,COALESCE(sum(amount_minor),0)::text AS amount_minor,count(*)::int AS payment_count
         FROM restaurant_payments
         WHERE tenant_id=$1 AND paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND paid_at < (($3::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
         GROUP BY method ORDER BY method`,
        [tenantId, from, to],
      )
      const refunds = await client.query(
        `SELECT COALESCE(sum(amount_minor),0)::text AS refunded_minor,count(*)::int AS refund_count
         FROM restaurant_refunds
         WHERE tenant_id=$1 AND created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND created_at < (($3::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`,
        [tenantId, from, to],
      )
      const daily = await client.query(
        `SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
           count(*)::int AS order_count,COALESCE(sum(total_minor),0)::text AS sales_minor,
           COALESCE(sum(tax_minor),0)::text AS tax_minor
         FROM restaurant_orders
         WHERE tenant_id=$1 AND status <> 'cancelled'
           AND created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND created_at < (($3::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
         GROUP BY (created_at AT TIME ZONE 'Asia/Kolkata')::date ORDER BY day`,
        [tenantId, from, to],
      )
      const topItems = await client.query(
        `SELECT oi.item_name_snapshot,COALESCE(oi.variant_name_snapshot,'') AS variant_name_snapshot,
           sum(oi.quantity)::int AS quantity,COALESCE(sum(oi.line_total_minor),0)::text AS sales_minor
         FROM restaurant_order_items oi
         JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id
         WHERE oi.tenant_id=$1 AND o.status <> 'cancelled'
           AND o.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND o.created_at < (($3::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
           AND oi.status NOT IN ('cancelled','unavailable')
         GROUP BY oi.item_name_snapshot,oi.variant_name_snapshot
         ORDER BY sum(oi.quantity) DESC,sum(oi.line_total_minor) DESC
         LIMIT 10`,
        [tenantId, from, to],
      )
      return { summary: summary.rows[0], payments: payments.rows, refunds: refunds.rows[0], daily: daily.rows, top_items: topItems.rows }
    })
    send(response, 200, { from, to, ...report })
    return true
  } catch (error) {
    send(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'restaurant_reports_failed' })
    return true
  }
}
