import { apiFetch } from './auth'
import { useEffect, useState } from 'react'
import { AlertCircle, BarChart3, Download, FileCheck2, RefreshCw } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
type DailySummary = { business_date:string; order_count:number; revenue_minor:string; tax_minor:string; cancelled_count:number; refunds_minor:string; average_order_minor:string|null; metrics:{payments:{method:string;payment_count:number;amount_minor:string}[];refund_count:number;top_items:{item_name_snapshot:string;variant_name_snapshot:string;quantity:number;sales_minor:string}[]} }
type Report = {
 from:string;to:string
 summary:{order_count:number;subtotal_minor:string;tax_minor:string;sales_minor:string}
 payments:{method:string;amount_minor:string;payment_count:number}[]
 refunds:{refunded_minor:string;refund_count:number}
 daily:{day:string;order_count:number;sales_minor:string;tax_minor:string}[]
 top_items:{item_name_snapshot:string;variant_name_snapshot:string;quantity:number;sales_minor:string}[]
}
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date())
const money = (minor:string|number) => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(Number(minor)/100)
function csvCell(value:unknown){const s=String(value??'');return '"'+s.replace(/"/g,'""')+'"'}
export default function RestaurantReports({initialSlug=''}:{initialSlug?:string}={}){
 const [slug,setSlug]=useState(initialSlug)
 const [from,setFrom]=useState(today())
 const [to,setTo]=useState(today())
 const [report,setReport]=useState<Report|null>(null)
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const [dailySummary,setDailySummary]=useState<DailySummary|null>(null)
 const [archiving,setArchiving]=useState(false)
 async function archiveDailySummary(){
  if(!slug.trim()||from!==to){setError('Select one date and load its report before archiving.');return}
  setArchiving(true);setError('')
  try{
   const res=await apiFetch(`${API_BASE}/restaurant/${encodeURIComponent(slug.trim().toLowerCase())}/daily-summary?date=${encodeURIComponent(from)}`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}})
   const data=await res.json().catch(()=>({}))
   if(!res.ok)throw new Error(data.error||'Could not archive daily summary')
   setDailySummary(data.summary)
  }catch(e){setError(e instanceof Error?e.message:'Could not archive daily summary')}
  finally{setArchiving(false)}
 }
 async function load(){
  if(!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug.trim().toLowerCase())){setError('Enter a valid restaurant slug.');return}
  if(!from||!to||from>to){setError('Choose a valid date range.');return}
  setBusy(true);setError('')
  try{
   const query=new URLSearchParams({from,to})
   const res=await apiFetch(`${API_BASE}/restaurant/${encodeURIComponent(slug.trim().toLowerCase())}/reports?${query}`,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}})
   const data=await res.json().catch(()=>({}))
   if(!res.ok)throw new Error(data.error||'Could not load reports')
   setReport(data);setDailySummary(null)
  }catch(e){setReport(null);setError(e instanceof Error?e.message:'Could not load reports')}
  finally{setBusy(false)}
 }
 useEffect(()=>{if(initialSlug) void load()},[initialSlug])
 function exportCsv(){
  if(!report)return
  const rows=[['Section','Date / Name','Orders / Quantity','Amount (INR)'],
   ['Summary', 'Orders',report.summary.order_count,money(report.summary.sales_minor)],
   ['Summary','Subtotal','',money(report.summary.subtotal_minor)],
   ['Summary','Tax','',money(report.summary.tax_minor)],
   ['Summary','Refunds',report.refunds.refund_count,money(report.refunds.refunded_minor)],
   ...report.daily.map(x=>['Daily',x.day,x.order_count,money(x.sales_minor)]),
   ...report.payments.map(x=>['Payment method',x.method,x.payment_count,money(x.amount_minor)]),
   ...report.top_items.map(x=>['Top item',x.item_name_snapshot+(x.variant_name_snapshot?' - '+x.variant_name_snapshot:''),x.quantity,money(x.sales_minor)])]
  const blob=new Blob([rows.map(row=>row.map(csvCell).join(',')).join('\\r\\n')],{type:'text/csv;charset=utf-8'})
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`restaurant-report-${report.from}-to-${report.to}.csv`;a.click();URL.revokeObjectURL(url)
 }
 return <section className="restaurant-menu">
  <div className="restaurant-menu-heading"><div className="restaurant-menu-title"><div className="restaurant-menu-icon"><BarChart3 size={20}/></div><div><span className="eyebrow">RESTAURANT SUITE</span><h2>Sales reports</h2><p>Daily sales, orders, payment mix, refunds and best-selling menu items.</p></div></div></div>
  <div className="restaurant-report-filters">
   {!initialSlug && <label>Restaurant slug<input value={slug} onChange={e=>setSlug(e.target.value)} placeholder="e.g. my-restaurant" autoCapitalize="none"/></label>}
   <label>From<input type="date" value={from} max={to||undefined} onChange={e=>setFrom(e.target.value)}/></label>
   <label>To<input type="date" value={to} min={from||undefined} onChange={e=>setTo(e.target.value)}/></label>
   <button className="button primary" onClick={()=>void load()} disabled={busy}><RefreshCw size={15}/>{busy?'Loading…':'Load report'}</button>
  </div>
  {error&&<div className="restaurant-menu-alert"><AlertCircle size={16}/>{error}</div>}
  {!report?<div className="restaurant-menu-empty">Choose a restaurant and date range to view its saved sales data.</div>:<>
   <div className="restaurant-report-toolbar"><span>{report.from} to {report.to}</span><div className="restaurant-report-actions">{from===to&&<button className="button secondary" onClick={()=>void archiveDailySummary()} disabled={archiving}><FileCheck2 size={15}/>{archiving?'Saving…':'Archive daily summary'}</button>}<button className="button secondary" onClick={exportCsv}><Download size={15}/>Export CSV</button></div></div>
   {dailySummary&&<div className="restaurant-report-panel restaurant-report-wide"><h3>Archived daily summary · {dailySummary.business_date}</h3><div className="restaurant-report-row"><span>Orders / cancelled</span><b>{dailySummary.order_count} / {dailySummary.cancelled_count}</b></div><div className="restaurant-report-row"><span>Average order</span><b>{money(dailySummary.average_order_minor||'0')}</b></div><div className="restaurant-report-row"><span>Payments recorded</span><b>{money(dailySummary.metrics.payments.reduce((sum,item)=>sum+Number(item.amount_minor),0))}</b></div><div className="restaurant-report-row"><span>Refunds recorded</span><b>{money(dailySummary.refunds_minor)}</b></div><p className="restaurant-settings-note">Snapshot saved for this business date. Archive again to refresh it with later corrections.</p></div>}
   <div className="restaurant-report-metrics">
    <article><small>Net order sales</small><strong>{money(report.summary.sales_minor)}</strong><span>{report.summary.order_count} orders</span></article>
    <article><small>Subtotal</small><strong>{money(report.summary.subtotal_minor)}</strong><span>Before tax</span></article>
    <article><small>Tax collected on orders</small><strong>{money(report.summary.tax_minor)}</strong><span>Recorded order tax</span></article>
    <article><small>Refunds recorded</small><strong>{money(report.refunds.refunded_minor)}</strong><span>{report.refunds.refund_count} refunds</span></article>
   </div>
   <div className="restaurant-report-grid">
    <div className="restaurant-report-panel"><h3>Daily sales</h3>{report.daily.length?report.daily.map(day=><div className="restaurant-report-row" key={day.day}><span>{day.day}<small>{day.order_count} orders</small></span><b>{money(day.sales_minor)}</b></div>):<p className="restaurant-report-empty">No orders in this period.</p>}</div>
    <div className="restaurant-report-panel"><h3>Payment methods</h3>{report.payments.length?report.payments.map(item=><div className="restaurant-report-row" key={item.method}><span>{item.method.toUpperCase()}<small>{item.payment_count} payments</small></span><b>{money(item.amount_minor)}</b></div>):<p className="restaurant-report-empty">No payments recorded.</p>}</div>
    <div className="restaurant-report-panel restaurant-report-wide"><h3>Top-selling items</h3>{report.top_items.length?report.top_items.map((item,index)=><div className="restaurant-report-row" key={item.item_name_snapshot+'-'+item.variant_name_snapshot}><span><b className="restaurant-report-rank">{index+1}</b>{item.item_name_snapshot}{item.variant_name_snapshot&&<small>{item.variant_name_snapshot}</small>}</span><b>{item.quantity} sold · {money(item.sales_minor)}</b></div>):<p className="restaurant-report-empty">No item sales in this period.</p>}</div>
   </div>
   <p className="restaurant-settings-note">Sales exclude cancelled orders. Payment totals show recorded staff-confirmed collections; they may differ from order sales when balances remain unpaid. This report is operational, not a statutory GST return.</p>
  </>}
 </section>
}
