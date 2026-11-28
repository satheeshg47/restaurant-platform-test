import { withTenantTransaction } from '../db/pool.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
function fail(statusCode, code) { const error = new Error(code); error.statusCode = statusCode; throw error }

export function financialYear(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: '2-digit', month: '2-digit' }).formatToParts(date)
  const year = Number(parts.find(part => part.type === 'year').value)
  const month = Number(parts.find(part => part.type === 'month').value)
  const start = month >= 4 ? year : year - 1
  return `${String(start).padStart(2,'0')}-${String((start + 1) % 100).padStart(2,'0')}`
}

export async function handleRestaurantInvoice(request, response, { database, tenantId, actor, sessionId }) {
  try {
    if (!['owner','manager','waiter'].includes(actor.role)) fail(403, 'restaurant_role_forbidden')
    if (request.method !== 'POST') return false
    if (!UUID.test(sessionId || '')) fail(404, 'table_session_not_found')
    const invoice = await withTenantTransaction(database, tenantId, async client => {
      const session = await client.query(
        `SELECT s.id,s.status,t.label AS table_label,p.display_name,p.legal_name,p.gstin,p.fssai_license_no,
           p.address_line1,p.address_line2,p.city,p.state_name,p.state_code,p.postal_code,
           p.invoice_prefix,p.tax_mode,p.gst_rate,p.tax_inclusive
         FROM restaurant_table_sessions s
         JOIN restaurant_tables t ON t.tenant_id=s.tenant_id AND t.id=s.table_id
         JOIN restaurant_profiles p ON p.tenant_id=s.tenant_id
         WHERE s.tenant_id=$1 AND s.id=$2 FOR UPDATE OF s`,
        [tenantId, sessionId],
      )
      const profile = session.rows[0]
      if (!profile) fail(404, 'table_session_not_found')
      const existing = await client.query(
        'SELECT * FROM restaurant_invoices WHERE tenant_id=$1 AND session_id=$2',
        [tenantId, sessionId],
      )
      if (existing.rows[0]) return existing.rows[0]
      if (profile.status !== 'open') fail(409, 'table_session_not_open')
      if (profile.tax_mode !== 'gst') fail(409, 'gst_tax_mode_required')
      if (!profile.legal_name?.trim() || !profile.gstin || !GSTIN.test(profile.gstin) ||
          !profile.address_line1?.trim() || !profile.city?.trim() ||
          !profile.state_name?.trim() || !/^\d{2}$/.test(String(profile.state_code || '')) ||
          !profile.postal_code?.trim()) fail(409, 'gst_business_profile_incomplete')
      if (profile.gstin.slice(0,2) !== String(profile.state_code)) fail(409, 'gstin_state_code_mismatch')

      const orders = await client.query(
        `SELECT id,order_number,subtotal_minor,tax_minor,total_minor,
           tax_mode_snapshot,tax_rate_snapshot,tax_inclusive_snapshot
         FROM restaurant_orders WHERE tenant_id=$1 AND session_id=$2 AND status <> 'cancelled'
         ORDER BY created_at,id`,
        [tenantId, sessionId],
      )
      if (!orders.rows.length) fail(409, 'invoice_has_no_orders')
      const unfinished = await client.query(
        `SELECT count(*)::int AS count FROM restaurant_order_items oi
         JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id
         WHERE oi.tenant_id=$1 AND o.session_id=$2 AND o.status <> 'cancelled'
           AND oi.status NOT IN ('served','unavailable','cancelled')`,
        [tenantId, sessionId],
      )
      if (Number(unfinished.rows[0]?.count || 0) > 0) fail(409, 'orders_not_fully_served')
      const payments = await client.query(
        'SELECT COALESCE(sum(amount_minor),0)::text AS amount FROM restaurant_payments WHERE tenant_id=$1 AND session_id=$2',
        [tenantId, sessionId],
      )
      const refunds = await client.query(
        `SELECT COALESCE(sum(amount_minor) FILTER (WHERE was_paid=true),0)::text AS paid_refunds,
           COALESCE(sum(amount_minor) FILTER (WHERE was_paid=false),0)::text AS waived
         FROM restaurant_refunds WHERE tenant_id=$1 AND session_id=$2`,
        [tenantId, sessionId],
      )
      const due = orders.rows.reduce((sum,row)=>sum+BigInt(row.total_minor),0n)
      const paid = BigInt(payments.rows[0]?.amount || 0)
      const paidRefunds = BigInt(refunds.rows[0]?.paid_refunds || 0)
      const waived = BigInt(refunds.rows[0]?.waived || 0)
      if (due - paid + paidRefunds - waived !== 0n) fail(409, 'settle_balance_before_invoice')
      const items = await client.query(
        `SELECT oi.order_id,oi.item_name_snapshot,oi.variant_name_snapshot,oi.addons_snapshot,
           oi.quantity,oi.unit_price_minor,oi.addons_price_minor,oi.line_total_minor,
           COALESCE(i.hsn_sac_code,'') AS hsn_sac_code
         FROM restaurant_order_items oi
         LEFT JOIN restaurant_menu_items i ON i.tenant_id=oi.tenant_id AND i.id=oi.item_id
         JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id
         WHERE oi.tenant_id=$1 AND o.session_id=$2 AND o.status <> 'cancelled'
           AND oi.status NOT IN ('cancelled','unavailable')
         ORDER BY oi.created_at,oi.id`,
        [tenantId, sessionId],
      )
      if (items.rows.some(row => !/^(?:\d{4}|\d{6}|\d{8})$/.test(String(row.hsn_sac_code || '')))) fail(409, 'invoice_hsn_sac_missing')
      const subtotal = orders.rows.reduce((sum,row)=>sum + BigInt(row.subtotal_minor) - ((row.tax_inclusive_snapshot ?? profile.tax_inclusive) ? BigInt(row.tax_minor) : 0n),0n)
      const tax = orders.rows.reduce((sum,row)=>sum+BigInt(row.tax_minor),0n)
      const total = orders.rows.reduce((sum,row)=>sum+BigInt(row.total_minor),0n)
      if (orders.rows.some(row => (row.tax_mode_snapshot || profile.tax_mode) !== 'gst')) fail(409, 'mixed_tax_modes_not_supported')
      const rates = new Set(orders.rows.map(row => Number(row.tax_rate_snapshot ?? profile.gst_rate)))
      const inclusiveModes = new Set(orders.rows.map(row => Boolean(row.tax_inclusive_snapshot ?? profile.tax_inclusive)))
      if (rates.size > 1 || inclusiveModes.size > 1) fail(409, 'mixed_tax_rates_not_supported')
      if (paidRefunds > 0n || waived > 0n) fail(409, 'invoice_adjustments_not_supported')
      const gstOrders = orders.rows.filter(row => (row.tax_mode_snapshot || profile.tax_mode) === 'gst')
      const gstTax = gstOrders.reduce((sum,row)=>sum+BigInt(row.tax_minor),0n)
      const cgst = gstTax / 2n
      const sgst = gstTax - cgst
      const otherTax = tax - gstTax
      const fy = financialYear()
      const counter = await client.query(
        `INSERT INTO restaurant_invoice_counters(tenant_id,financial_year,next_number)
         VALUES ($1,$2,2)
         ON CONFLICT (tenant_id,financial_year)
         DO UPDATE SET next_number=restaurant_invoice_counters.next_number+1
         RETURNING next_number-1 AS allocated_number`,
        [tenantId, fy],
      )
      const invoiceNumber = `${profile.invoice_prefix}/${fy}/${String(counter.rows[0].allocated_number).padStart(6,'0')}`
      const seller = {
        display_name: profile.display_name, legal_name: profile.legal_name, gstin: profile.gstin, fssai_license_no: profile.fssai_license_no,
        address_line1: profile.address_line1, address_line2: profile.address_line2,
        city: profile.city, state_name: profile.state_name, state_code: String(profile.state_code),
        postal_code: profile.postal_code, place_of_supply: `${profile.state_code}-${profile.state_name}`,
      }
      const itemsSnapshot = items.rows.map(row => ({
        order_number: orders.rows.find(order=>order.id===row.order_id)?.order_number,
        item_name: row.item_name_snapshot, variant_name: row.variant_name_snapshot,
        addons: row.addons_snapshot, quantity: row.quantity, unit_price_minor: row.unit_price_minor,
        addons_price_minor: row.addons_price_minor, line_total_minor: row.line_total_minor,
        hsn_sac_code: row.hsn_sac_code,
      }))
      const taxRate = gstOrders.length ? Number(gstOrders[0].tax_rate_snapshot ?? profile.gst_rate) : 0
      const result = await client.query(
        `INSERT INTO restaurant_invoices
         (tenant_id,session_id,invoice_number,financial_year,seller_snapshot,items_snapshot,
          subtotal_minor,tax_minor,cgst_minor,sgst_minor,other_tax_minor,total_minor,tax_rate,
          tax_inclusive,created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [tenantId,sessionId,invoiceNumber,fy,JSON.stringify(seller),JSON.stringify(itemsSnapshot),
          String(subtotal),String(tax),String(cgst),String(sgst),String(otherTax),String(total),
          taxRate,Boolean(gstOrders[0]?.tax_inclusive_snapshot ?? profile.tax_inclusive),actor.staffId ?? null],
      )
      await client.query(
        "UPDATE restaurant_table_sessions SET status='closed',closed_at=now(),closed_by=$3 WHERE tenant_id=$1 AND id=$2 AND status='open'",
        [tenantId, sessionId, actor.staffId ?? null],
      )
      return result.rows[0]
    })
    send(response, 201, { invoice })
    return true
  } catch (error) {
    send(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'restaurant_invoice_failed' })
    return true
  }
}
