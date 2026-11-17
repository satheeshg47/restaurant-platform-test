import type { Env } from './types.ts'

type Actor = { tenantId: string; userId: string; staffId: string | null; role: string }
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN=/^[A-Za-z0-9_-]{43}$/
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})
const fail=(status:number,code:string):never=>{throw Object.assign(new Error(code),{status})}
async function readBody(request:Request):Promise<Record<string,unknown>>{
 const raw=await request.text()
 if(new TextEncoder().encode(raw).byteLength>8192) throw Object.assign(new Error('payload_too_large'),{status:413})
 try{const value:unknown=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('invalid_request'),{status:400});return value as Record<string,unknown>}
 catch(error){if(error&&typeof error==='object'&&'status'in error)throw error;throw Object.assign(new Error('invalid_request'),{status:400})}
}
async function tableForToken(env:Env,tenantId:string,token:string){
 if(!TOKEN.test(token)) fail(404,'qr_not_found')
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))
 const hash=[...digest].map(v=>v.toString(16).padStart(2,'0')).join('')
 const table=await env.DB.prepare('SELECT id FROM restaurant_tables WHERE tenant_id=? AND public_token_hash=? AND active=1 LIMIT 1').bind(tenantId,hash).first<{id:string}>()
 if(!table) throw Object.assign(new Error('qr_not_found'),{status:404})
 return table
}
export async function handleGuestReviewRoutes(request:Request,env:Env,tenantId:string,token:string):Promise<Response>{
 try{
  const table=await tableForToken(env,tenantId,token)
  if(request.method==='GET'){
   const row=await env.DB.prepare(`SELECT s.id,s.closed_at,CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS already_reviewed
    FROM restaurant_table_sessions s LEFT JOIN restaurant_reviews r ON r.tenant_id=s.tenant_id AND r.session_id=s.id
    WHERE s.tenant_id=? AND s.table_id=? AND s.status='closed' AND s.closed_at>=datetime('now','-30 days')
    ORDER BY s.closed_at DESC LIMIT 1`).bind(tenantId,table.id).first<{id:string;closed_at:string;already_reviewed:number}>()
   return json(200,{review_session:row&&!row.already_reviewed?{id:row.id,closed_at:row.closed_at}:null,already_reviewed:Boolean(row?.already_reviewed)})
  }
  if(request.method==='POST'){
   const body=await readBody(request),rating=Number(body.rating),sessionId=String(body.session_id||'')
   if(!UUID.test(sessionId)||!Number.isInteger(rating)||rating<1||rating>5) throw Object.assign(new Error('invalid_review'),{status:400})
   const comment=typeof body.comment==='string'?body.comment.trim().slice(0,1000):''
   const session=await env.DB.prepare("SELECT id FROM restaurant_table_sessions WHERE tenant_id=? AND table_id=? AND id=? AND status='closed' AND closed_at>=datetime('now','-30 days')").bind(tenantId,table.id,sessionId).first()
   if(!session) fail(409,'review_available_after_session_close')
   try{
    const review=await env.DB.prepare('INSERT INTO restaurant_reviews(tenant_id,session_id,table_id,rating,comment) VALUES(?,?,?,?,?) RETURNING id,rating,comment,created_at').bind(tenantId,sessionId,table.id,rating,comment).first()
    return json(201,{review})
   }catch(error){
    const message=error instanceof Error?error.message:''
    if(/UNIQUE|constraint/i.test(message)) fail(409,'session_already_reviewed')
    throw error
   }
  }
  return json(405,{error:'method_not_allowed'})
 }catch(error){console.error('D1_GUEST_REVIEW_ERROR',error);return json(error&&typeof error==='object'&&'status'in error?Number(error.status):500,{error:error instanceof Error&&'status'in error?error.message:'guest_review_failed'})}
}
export async function handleRestaurantReviewRoutes(request:Request,env:Env,actor:Actor,parts:string[]):Promise<Response|null>{
 try{
  if(!['owner','manager'].includes(actor.role)) fail(403,'restaurant_role_forbidden')
  if(parts.length===3&&request.method==='GET'){
   const result=await env.DB.prepare(`SELECT r.id,r.rating,r.comment,r.visibility,r.owner_response,r.created_at,r.responded_at,t.label AS table_label,s.closed_at
    FROM restaurant_reviews r JOIN restaurant_tables t ON t.tenant_id=r.tenant_id AND t.id=r.table_id
    JOIN restaurant_table_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id
    WHERE r.tenant_id=? ORDER BY r.created_at DESC LIMIT 250`).bind(actor.tenantId).all()
   return json(200,{reviews:result.results})
  }
  if(parts.length===4&&request.method==='PATCH'){
   const id=parts[3];if(!UUID.test(id)) fail(404,'review_not_found')
   const body=await readBody(request),keys=Object.keys(body)
   if(!keys.length||keys.some(k=>!['visibility','owner_response'].includes(k))) fail(400,'invalid_review_update')
   const visibility=body.visibility
   if(visibility!==undefined&&(typeof visibility!=='string'||!['published','hidden'].includes(visibility))) throw Object.assign(new Error('invalid_review_visibility'),{status:400})
   const ownerResponse=body.owner_response
   if(ownerResponse!==undefined&&(typeof ownerResponse!=='string'||ownerResponse.trim().length>1000)) throw Object.assign(new Error('invalid_owner_response'),{status:400})
   const existing=await env.DB.prepare('SELECT id FROM restaurant_reviews WHERE tenant_id=? AND id=?').bind(actor.tenantId,id).first()
   if(!existing) fail(404,'review_not_found')
   const sets:string[]=[],values:unknown[]=[actor.tenantId,id]
   if(Object.hasOwn(body,'visibility')){values.push(visibility);sets.push('visibility=?')}
   if(Object.hasOwn(body,'owner_response')){const responseText=(ownerResponse as string).trim()||null;values.push(responseText);sets.push('owner_response=?');sets.push(`responded_at=CASE WHEN ? IS NULL THEN NULL ELSE ${"strftime('%Y-%m-%dT%H:%M:%fZ','now')"} END`);values.push(responseText);sets.push('responded_by=?');values.push(actor.staffId)}
   const result=await env.DB.prepare(`UPDATE restaurant_reviews SET ${sets.join(',')} WHERE tenant_id=? AND id=? RETURNING id,rating,comment,visibility,owner_response,created_at,responded_at`).bind(...values.slice(2),actor.tenantId,id).first()
   return json(200,{review:result})
  }
  return null
 }catch(error){return json(error&&typeof error==='object'&&'status'in error?Number(error.status):500,{error:error instanceof Error&&'status'in error?error.message:'restaurant_reviews_failed'})}
}
