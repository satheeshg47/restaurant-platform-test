import type { Env } from './types.ts'
import { verifyGuestSessionPin } from './guest-session-security.ts'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN=/^[A-Za-z0-9_-]{43}$/
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})
const fail=(status:number,code:string):never=>{throw Object.assign(new Error(code),{status})}
async function readBody(request:Request):Promise<Record<string,unknown>>{
 const raw=await request.text()
 if(new TextEncoder().encode(raw).byteLength>8192)throw Object.assign(new Error('payload_too_large'),{status:413})
 try{const value:unknown=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('invalid_request'),{status:400});return value as Record<string,unknown>}
 catch(error){if(error&&typeof error==='object'&&'status'in error)throw error;throw Object.assign(new Error('invalid_request'),{status:400})}
}
async function guestTable(env:Env,tenantId:string,token:string){
 if(!TOKEN.test(token))fail(404,'qr_not_found')
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))
 const hash=[...digest].map(x=>x.toString(16).padStart(2,'0')).join('')
 const table=await env.DB.prepare('SELECT id FROM restaurant_tables WHERE tenant_id=? AND public_token_hash=? AND active=1 LIMIT 1').bind(tenantId,hash).first<{id:string}>()
 if(!table)throw Object.assign(new Error('qr_not_found'),{status:404})
 return table
}
export async function handleGuestLifecycle(request:Request,env:Env,tenantId:string,token:string,parts:string[]):Promise<Response>{
 try{
  if(parts[4]==='session'&&parts.length===6&&parts[5]==='verify'&&request.method==='POST'){
   const body=await readBody(request),sessionId=String(body.session_id||'')
   const table=await guestTable(env,tenantId,token)
   await verifyGuestSessionPin(env,tenantId,table.id,sessionId,body.pin)
   return json(200,{verified:true})
  }
  if(parts[4]==='orders'&&parts.length===6&&request.method==='GET'){
   const table=await guestTable(env,tenantId,token)
   if(!UUID.test(parts[5]))fail(404,'order_not_found')
   const order=await env.DB.prepare(`SELECT id,order_number,status,subtotal_minor,tax_minor,total_minor,special_instructions,created_at,ready_at,served_at
    FROM restaurant_orders WHERE tenant_id=? AND table_id=? AND id=?`).bind(tenantId,table.id,parts[5]).first<Record<string,unknown>>()
   if(!order)fail(404,'order_not_found')
   const items=await env.DB.prepare(`SELECT id,item_name_snapshot,variant_name_snapshot,addons_snapshot,customization,quantity,unit_price_minor,addons_price_minor,line_total_minor,status,ready_at,served_at,unavailable_reason
    FROM restaurant_order_items WHERE tenant_id=? AND order_id=? ORDER BY created_at,id`).bind(tenantId,parts[5]).all()
   return json(200,{order,items:items.results})
  }
  if(parts[4]==='orders'&&parts.length===7&&parts[6]==='cancel'&&request.method==='POST'){
   const body=await readBody(request),sessionId=String(body.session_id||''),orderId=parts[5]
   if(!UUID.test(orderId)||!UUID.test(sessionId))fail(400,'invalid_cancel_request')
   const table=await guestTable(env,tenantId,token)
   await verifyGuestSessionPin(env,tenantId,table.id,sessionId,body.guest_pin)
   const order=await env.DB.prepare('SELECT id FROM restaurant_orders WHERE tenant_id=? AND table_id=? AND session_id=? AND id=?').bind(tenantId,table.id,sessionId,orderId).first()
   if(!order)fail(404,'order_not_found')
   const itemId=body.order_item_id??null
   if(itemId!==null){
    if(typeof itemId!=='string'||!UUID.test(itemId))fail(400,'invalid_order_item')
    const item=await env.DB.prepare('SELECT id,status FROM restaurant_order_items WHERE tenant_id=? AND order_id=? AND id=?').bind(tenantId,orderId,itemId).first<{id:string;status:string}>()
    if(!item)throw Object.assign(new Error('order_item_not_found'),{status:404})
    if(!['new','accepted'].includes(item.status))fail(409,'cancellation_window_closed')
   }else{
    const preparing=await env.DB.prepare("SELECT count(*) AS count FROM restaurant_order_items WHERE tenant_id=? AND order_id=? AND status IN ('preparing','ready','served')").bind(tenantId,orderId).first<{count:number}>()
    if(Number(preparing?.count||0)>0)fail(409,'cancellation_window_closed')
   }
   const note='Customer requested order cancellation'
   const result=await env.DB.prepare(`INSERT INTO restaurant_service_requests(tenant_id,session_id,table_id,request_type,note,order_id,order_item_id)
    VALUES(?,?,?,'cancel_order',?,?,?) RETURNING id,status,created_at`).bind(tenantId,sessionId,table.id,note,orderId,itemId).first()
   return json(201,{request:result})
  }
  if(parts[4]==='requests'&&parts.length===5&&request.method==='POST'){
   const body=await readBody(request),sessionId=String(body.session_id||''),requestType=body.request_type
   if(!UUID.test(sessionId)||!['call_waiter','need_water','request_bill','other'].includes(String(requestType)))fail(400,'invalid_service_request')
   const note=typeof body.note==='string'?body.note.trim().slice(0,250):''
   const table=await guestTable(env,tenantId,token)
   await verifyGuestSessionPin(env,tenantId,table.id,sessionId,body.guest_pin)
   const recent=await env.DB.prepare("SELECT count(*) AS count FROM restaurant_service_requests WHERE tenant_id=? AND session_id=? AND created_at>=datetime('now','-1 minute')").bind(tenantId,sessionId).first<{count:number}>()
   if(Number(recent?.count||0)>=5)fail(429,'service_request_rate_limited')
   const inserted=await env.DB.prepare('INSERT INTO restaurant_service_requests(tenant_id,session_id,table_id,request_type,note) VALUES(?,?,?,?,?) RETURNING id,status,created_at').bind(tenantId,sessionId,table.id,requestType,note).first()
   return json(201,{request:inserted})
  }
  return json(404,{error:'guest_route_not_found'})
 }catch(error){
  const status=error&&typeof error==='object'&&'status'in error?Number(error.status):500
  const message=error instanceof Error&&status<500?error.message:status===500?'guest_request_failed':'guest_request_failed'
  return json(status,{error:message})
 }
}
