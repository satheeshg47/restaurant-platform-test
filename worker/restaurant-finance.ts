import type { Env } from './types.ts'

type Actor = { tenantId: string; userId: string; staffId: string | null; role: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
const fail = (status: number, code: string): never => { throw Object.assign(new Error(code), { status }) }
const DAY = /^\d{4}-\d{2}-\d{2}$/
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

function validDay(value: string | null): value is string {
  if (!value || !DAY.test(value)) return false
  const date = new Date(value + 'T00:00:00.000Z')
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === value
}
function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date)
  return Object.fromEntries(parts.map(p=>[p.type,p.value])) as Record<string,string>
}
function zonedMidnightUtc(day: string, timezone: string): string {
  const [year,month,date] = day.split('-').map(Number)
  const target = Date.UTC(year,month-1,date)
  let guess = target
  const formatter = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})
  for (let i=0;i<3;i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(p=>[p.type,p.value]))
    const represented = Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second))
    const delta = target - represented
    guess += delta
    if (!delta) break
  }
  return new Date(guess).toISOString()
}
function addDays(day: string, count: number) {
  const d = new Date(day+'T00:00:00.000Z')
  d.setUTCDate(d.getUTCDate()+count)
  return d.toISOString().slice(0,10)
}
function financialYear(date = new Date()) {
  const p = localParts(date,'Asia/Kolkata')
  const year = Number(p.year)%100, month = Number(p.month)
  const start = month >= 4 ? year : year-1
  return String(start).padStart(2,'0')+'-'+String((start+1)%100).padStart(2,'0')
}
function parseJson(value: unknown, fallback: unknown = {}) {
  if (typeof value !== 'string') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}
async function invoiceForSession(env: Env, actor: Actor, sessionId: string) {
  if (!UUID.test(sessionId)) fail(404,'table_session_not_found')
  const existing = await env.DB.prepare('SELECT * FROM restaurant_invoices WHERE tenant_id=? AND session_id=?').bind(actor.tenantId,sessionId).first<Record<string,unknown>>()
  if (existing) return { invoice: normalizeInvoice(existing), existing: true }
  const session = await env.DB.prepare(`SELECT s.id,s.status,t.label AS table_label,p.display_name,p.legal_name,p.gstin,p.address_line1,p.address_line2,p.city,p.state_name,p.state_code,p.postal_code,p.invoice_prefix,p.tax_mode,p.gst_rate,p.tax_inclusive,p.timezone
    FROM restaurant_table_sessions s JOIN restaurant_tables t ON t.tenant_id=s.tenant_id AND t.id=s.table_id
    JOIN restaurant_profiles p ON p.tenant_id=s.tenant_id WHERE s.tenant_id=? AND s.id=?`).bind(actor.tenantId,sessionId).first<Record<string,unknown>>()
  if (!session) fail(404,'table_session_not_found')
  if (session.status !== 'open') fail(409,'table_session_not_open')
  if (session.tax_mode !== 'gst') fail(409,'gst_tax_mode_required')
  const gstin = String(session.gstin||'')
  const stateCode = String(session.state_code||'')
  if (!String(session.legal_name||'').trim() || !GSTIN.test(gstin) || !String(session.address_line1||'').trim() || !String(session.city||'').trim() || !String(session.state_name||'').trim() || !/^\d{2}$/.test(stateCode) || !String(session.postal_code||'').trim()) fail(409,'gst_business_profile_incomplete')
  if (gstin.slice(0,2) !== stateCode) fail(409,'gstin_state_code_mismatch')
  const orders = await env.DB.prepare("SELECT id,order_number,status,subtotal_minor,tax_minor,total_minor,tax_mode_snapshot,tax_rate_snapshot,tax_inclusive_snapshot,created_at FROM restaurant_orders WHERE tenant_id=? AND session_id=? AND status<>'cancelled' ORDER BY created_at,id").bind(actor.tenantId,sessionId).all<Record<string,unknown>>()
  if (!orders.results.length) fail(409,'invoice_has_no_orders')
  const unfinished = await env.DB.prepare("SELECT count(*) AS count FROM restaurant_order_items oi JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id WHERE oi.tenant_id=? AND o.session_id=? AND o.status<>'cancelled' AND oi.status NOT IN ('served','unavailable','cancelled')").bind(actor.tenantId,sessionId).first<{count:number}>()
  if (Number(unfinished?.count||0)>0) fail(409,'orders_not_fully_served')
  const [payments,refunds,items] = await Promise.all([
    env.DB.prepare('SELECT COALESCE(sum(amount_minor),0) AS amount FROM restaurant_payments WHERE tenant_id=? AND session_id=?').bind(actor.tenantId,sessionId).first<{amount:number}>(),
    env.DB.prepare('SELECT COALESCE(sum(CASE WHEN was_paid=1 THEN amount_minor ELSE 0 END),0) AS paid_refunds,COALESCE(sum(CASE WHEN was_paid=0 THEN amount_minor ELSE 0 END),0) AS waived,count(*) AS adjustment_count FROM restaurant_refunds WHERE tenant_id=? AND session_id=?').bind(actor.tenantId,sessionId).first<{paid_refunds:number;waived:number;adjustment_count:number}>(),
    env.DB.prepare(`SELECT oi.order_id,oi.item_name_snapshot,oi.variant_name_snapshot,oi.addons_snapshot,oi.quantity,oi.unit_price_minor,oi.addons_price_minor,oi.line_total_minor,COALESCE(i.hsn_sac_code,'') AS hsn_sac_code
      FROM restaurant_order_items oi LEFT JOIN restaurant_menu_items i ON i.tenant_id=oi.tenant_id AND i.id=oi.item_id
      JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id
      WHERE oi.tenant_id=? AND o.session_id=? AND o.status<>'cancelled' AND oi.status NOT IN ('cancelled','unavailable') ORDER BY oi.created_at,oi.id`).bind(actor.tenantId,sessionId).all<Record<string,unknown>>(),
  ])
  const due = orders.results.reduce((sum,row)=>sum+BigInt(String(row.total_minor)),0n)
  const paid = BigInt(String(payments?.amount||0))
  const paidRefunds = BigInt(String(refunds?.paid_refunds||0))
  const waived = BigInt(String(refunds?.waived||0))
  if (Number(refunds?.adjustment_count||0)>0) fail(409,'invoice_adjustments_not_supported')
  if (due-paid+paidRefunds-waived !== 0n) fail(409,'settle_balance_before_invoice')
  if (items.results.some(row=>!/^(?:\d{4}|\d{6}|\d{8})$/.test(String(row.hsn_sac_code||'')))) fail(409,'invoice_hsn_sac_missing')
  if (orders.results.some(row=>(row.tax_mode_snapshot||session.tax_mode)!=='gst')) fail(409,'mixed_tax_modes_not_supported')
  const rates = new Set(orders.results.map(row=>Number(row.tax_rate_snapshot ?? session.gst_rate)))
  const inclusive = new Set(orders.results.map(row=>Boolean(row.tax_inclusive_snapshot ?? session.tax_inclusive)))
  if (rates.size>1 || inclusive.size>1) fail(409,'mixed_tax_rates_not_supported')
  const subtotal = orders.results.reduce((sum,row)=>sum+BigInt(String(row.subtotal_minor))-((row.tax_inclusive_snapshot ?? session.tax_inclusive)?BigInt(String(row.tax_minor)):0n),0n)
  const tax = orders.results.reduce((sum,row)=>sum+BigInt(String(row.tax_minor)),0n)
  const total = orders.results.reduce((sum,row)=>sum+BigInt(String(row.total_minor)),0n)
  const cgst = tax/2n, sgst = tax-cgst
  const fy = financialYear()
  const counter = await env.DB.prepare(`INSERT INTO restaurant_invoice_counters(tenant_id,financial_year,next_number) VALUES(?,?,2)
    ON CONFLICT(tenant_id,financial_year) DO UPDATE SET next_number=next_number+1 RETURNING next_number-1 AS allocated_number`).bind(actor.tenantId,fy).first<{allocated_number:number}>()
  if (!counter) fail(500,'invoice_number_allocation_failed')
  const prefix = String(session.invoice_prefix||'INV')
  const invoiceNumber = prefix+'/'+fy+'/'+String(counter.allocated_number).padStart(6,'0')
  const seller = {display_name:session.display_name,legal_name:session.legal_name,gstin,address_line1:session.address_line1,address_line2:session.address_line2,city:session.city,state_name:session.state_name,state_code:stateCode,postal_code:session.postal_code,place_of_supply:stateCode+'-'+session.state_name}
  const itemsSnapshot = items.results.map(row=>({order_number:orders.results.find(o=>o.id===row.order_id)?.order_number,item_name:row.item_name_snapshot,variant_name:row.variant_name_snapshot,addons:parseJson(row.addons_snapshot,[]),quantity:row.quantity,unit_price_minor:row.unit_price_minor,addons_price_minor:row.addons_price_minor,line_total_minor:row.line_total_minor,hsn_sac_code:row.hsn_sac_code}))
  const taxRate = Number(orders.results[0].tax_rate_snapshot ?? session.gst_rate)
  try {
    const invoice = await env.DB.prepare(`INSERT INTO restaurant_invoices(tenant_id,session_id,invoice_number,financial_year,seller_snapshot,items_snapshot,subtotal_minor,tax_minor,cgst_minor,sgst_minor,igst_minor,other_tax_minor,total_minor,tax_rate,tax_inclusive,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?) RETURNING *`).bind(actor.tenantId,sessionId,invoiceNumber,fy,JSON.stringify(seller),JSON.stringify(itemsSnapshot),String(subtotal),String(tax),String(cgst),String(sgst),String(total),taxRate,Number(Boolean([...inclusive][0])),actor.staffId).first<Record<string,unknown>>()
    if (!invoice) fail(500,'invoice_create_failed')
    const closed = await env.DB.prepare(`UPDATE restaurant_table_sessions SET status='closed',closed_at=${now},closed_by=?,close_reason='invoice' WHERE tenant_id=? AND id=? AND status='open'`).bind(actor.staffId,actor.tenantId,sessionId).run()
    if (!closed.meta.changes) fail(409,'table_session_not_open')
    return {invoice:normalizeInvoice(invoice),existing:false}
  } catch (error) {
    const retry = await env.DB.prepare('SELECT * FROM restaurant_invoices WHERE tenant_id=? AND session_id=?').bind(actor.tenantId,sessionId).first<Record<string,unknown>>()
    if (retry) return {invoice:normalizeInvoice(retry),existing:true}
    throw error
  }
}
function normalizeInvoice(row: Record<string,unknown>) {
  return {...row,seller_snapshot:parseJson(row.seller_snapshot),items_snapshot:parseJson(row.items_snapshot,[]),tax_inclusive:Boolean(row.tax_inclusive)}
}
async function reportData(env: Env, tenantId: string, from: string, to: string) {
  const profile = await env.DB.prepare('SELECT timezone FROM restaurant_profiles WHERE tenant_id=?').bind(tenantId).first<{timezone:string}>()
  const timezone = profile?.timezone || 'Asia/Kolkata'
  let start: string, end: string
  try { start=zonedMidnightUtc(from,timezone); end=zonedMidnightUtc(addDays(to,1),timezone) } catch { fail(400,'invalid_restaurant_timezone') }
  const [summary,payments,refunds,dailyRows,topItems] = await Promise.all([
    env.DB.prepare(`SELECT count(*) AS order_count,COALESCE(sum(subtotal_minor),0) AS subtotal_minor,COALESCE(sum(tax_minor),0) AS tax_minor,COALESCE(sum(total_minor),0) AS sales_minor FROM restaurant_orders WHERE tenant_id=? AND status<>'cancelled' AND created_at>=? AND created_at<?`).bind(tenantId,start,end).first<Record<string,number>>(),
    env.DB.prepare(`SELECT method,COALESCE(sum(amount_minor),0) AS amount_minor,count(*) AS payment_count FROM restaurant_payments WHERE tenant_id=? AND paid_at>=? AND paid_at<? GROUP BY method ORDER BY method`).bind(tenantId,start,end).all(),
    env.DB.prepare(`SELECT COALESCE(sum(amount_minor),0) AS refunded_minor,count(*) AS refund_count FROM restaurant_refunds WHERE tenant_id=? AND created_at>=? AND created_at<?`).bind(tenantId,start,end).first(),
    env.DB.prepare(`SELECT created_at,total_minor,tax_minor,status FROM restaurant_orders WHERE tenant_id=? AND created_at>=? AND created_at<? ORDER BY created_at LIMIT 50001`).bind(tenantId,start,end).all<Record<string,unknown>>(),
    env.DB.prepare(`SELECT oi.item_name_snapshot,COALESCE(oi.variant_name_snapshot,'') AS variant_name_snapshot,sum(oi.quantity) AS quantity,COALESCE(sum(oi.line_total_minor),0) AS sales_minor FROM restaurant_order_items oi JOIN restaurant_orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id WHERE oi.tenant_id=? AND o.status<>'cancelled' AND o.created_at>=? AND o.created_at<? AND oi.status NOT IN ('cancelled','unavailable') GROUP BY oi.item_name_snapshot,oi.variant_name_snapshot ORDER BY sum(oi.quantity) DESC,sum(oi.line_total_minor) DESC LIMIT 10`).bind(tenantId,start,end).all(),
  ])
  if (dailyRows.results.length>50000) fail(413,'report_range_too_large')
  const daily = new Map<string,{day:string;order_count:number;sales_minor:string;tax_minor:string;cancelled_count:number}>()
  for (const row of dailyRows.results) {
    const day = localParts(new Date(String(row.created_at)),timezone)
    const key = day.year+'-'+day.month+'-'+day.day
    const v = daily.get(key) || {day:key,order_count:0,sales_minor:'0',tax_minor:'0',cancelled_count:0}
    if (row.status==='cancelled') v.cancelled_count++
    else {v.order_count++;v.sales_minor=(BigInt(v.sales_minor)+BigInt(String(row.total_minor))).toString();v.tax_minor=(BigInt(v.tax_minor)+BigInt(String(row.tax_minor))).toString()}
    daily.set(key,v)
  }
  return {summary,payments:payments.results,refunds,daily:[...daily.values()].sort((a,b)=>a.day.localeCompare(b.day)),top_items:topItems.results,timezone}
}
export async function handleRestaurantFinance(request: Request, env: Env, actor: Actor, parts: string[], url: URL): Promise<Response|null> {
  if (parts[2]==='waiter' && parts[3]==='sessions' && parts.length===6 && parts[5]==='invoice' && request.method==='POST') {
    if (!['owner','manager','waiter'].includes(actor.role)) fail(403,'restaurant_role_forbidden')
    const result=await invoiceForSession(env,actor,parts[4])
    return json(result.existing?200:201,result)
  }
  if (parts[2]==='reports' && parts.length===3 && request.method==='GET') {
    if (!['owner','manager'].includes(actor.role)) fail(403,'restaurant_role_forbidden')
    const from=url.searchParams.get('from'),to=url.searchParams.get('to')
    if (!validDay(from)||!validDay(to)||from>to) fail(400,'invalid_report_date_range')
    if ((Date.parse(to)-Date.parse(from))/86400000+1>366) fail(400,'report_range_too_large')
    return json(200,{from,to,...await reportData(env,actor.tenantId,from,to)})
  }
  if (parts[2]==='daily-summary' && parts.length===3 && (request.method==='GET'||request.method==='POST')) {
    if (!['owner','manager'].includes(actor.role)) fail(403,'restaurant_role_forbidden')
    const day=url.searchParams.get('date')
    if (!validDay(day) || day>localParts(new Date(),'Asia/Kolkata').year+'-'+localParts(new Date(),'Asia/Kolkata').month+'-'+localParts(new Date(),'Asia/Kolkata').day) fail(400,'invalid_business_date')
    if (request.method==='GET') {
      const saved=await env.DB.prepare('SELECT business_date,order_count,revenue_minor,tax_minor,cancelled_count,refunds_minor,average_order_minor,metrics,updated_at FROM restaurant_daily_summaries WHERE tenant_id=? AND business_date=?').bind(actor.tenantId,day).first<Record<string,unknown>>()
      return saved?json(200,{summary:{...saved,metrics:parseJson(saved.metrics)}}):json(404,{error:'daily_summary_not_found'})
    }
    const data=await reportData(env,actor.tenantId,day,day)
    const count=Number(data.summary?.order_count||0),revenue=BigInt(String(data.summary?.sales_minor||0)),tax=BigInt(String(data.summary?.tax_minor||0))
    const average=count?(revenue/BigInt(count)).toString():null
    const metrics={payments:data.payments,refunds:data.refunds,top_items:data.top_items,timezone:data.timezone}
    const saved=await env.DB.prepare(`INSERT INTO restaurant_daily_summaries(tenant_id,business_date,order_count,revenue_minor,tax_minor,cancelled_count,refunds_minor,average_order_minor,metrics)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,business_date) DO UPDATE SET order_count=excluded.order_count,revenue_minor=excluded.revenue_minor,tax_minor=excluded.tax_minor,cancelled_count=excluded.cancelled_count,refunds_minor=excluded.refunds_minor,average_order_minor=excluded.average_order_minor,metrics=excluded.metrics
      RETURNING business_date,order_count,revenue_minor,tax_minor,cancelled_count,refunds_minor,average_order_minor,metrics,updated_at`).bind(actor.tenantId,day,count,String(revenue),String(tax),data.daily.reduce((s,d)=>s+d.cancelled_count,0),String(data.refunds?.refunded_minor||0),average,JSON.stringify(metrics)).first<Record<string,unknown>>()
    return json(200,{summary:saved?{...saved,metrics:parseJson(saved.metrics)}:null,archived:true})
  }
  return null
}
