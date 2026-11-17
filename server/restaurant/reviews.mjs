import { withTenantTransaction } from '../db/pool.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function send(response,status,body){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(body))}
function fail(statusCode,code){const error=new Error(code);error.statusCode=statusCode;throw error}
async function readBody(request){
 const chunks=[];let size=0
 for await(const chunk of request){size+=chunk.length;if(size>8192)fail(413,'payload_too_large');chunks.push(chunk)}
 try{const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'invalid_review_update');return body}
 catch(error){if(error.statusCode)throw error;fail(400,'invalid_review_update')}
}
export async function handleRestaurantReviews(request,response,{database,tenantId,actor,parts}){
 try{
  if(!['owner','manager'].includes(actor.role))fail(403,'restaurant_role_forbidden')
  if(parts.length===3&&request.method==='GET'){
   const result=await withTenantTransaction(database,tenantId,client=>client.query(
    `SELECT r.id,r.rating,r.comment,r.visibility,r.owner_response,r.created_at,r.responded_at,
       t.label AS table_label,s.closed_at
     FROM restaurant_reviews r
     JOIN restaurant_tables t ON t.tenant_id=r.tenant_id AND t.id=r.table_id
     JOIN restaurant_table_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id
     WHERE r.tenant_id=$1
     ORDER BY r.created_at DESC LIMIT 250`,[tenantId]))
   send(response,200,{reviews:result.rows});return true
  }
  if(parts.length===4&&request.method==='PATCH'){
   const id=parts[3];if(!UUID.test(id))fail(404,'review_not_found')
   const body=await readBody(request)
   const allowed=['visibility','owner_response']
   if(!Object.keys(body).length||Object.keys(body).some(key=>!allowed.includes(key)))fail(400,'invalid_review_update')
   if(body.visibility!==undefined&&!['published','hidden'].includes(body.visibility))fail(400,'invalid_review_visibility')
   if(body.owner_response!==undefined&&(typeof body.owner_response!=='string'||body.owner_response.trim().length>1000))fail(400,'invalid_owner_response')
   const result=await withTenantTransaction(database,tenantId,client=>{
    const values=[tenantId,id];const sets=[]
    if(Object.hasOwn(body,'visibility')){values.push(body.visibility);sets.push(`visibility=$${values.length}`)}
    if(Object.hasOwn(body,'owner_response')){
     values.push(body.owner_response.trim()||null);sets.push(`owner_response=$${values.length}`)
     sets.push('responded_at=CASE WHEN $'+values.length+'::text IS NULL THEN NULL ELSE now() END')
     values.push(actor.staffId||null);sets.push(`responded_by=$${values.length}`)
    }
    return client.query(
     `UPDATE restaurant_reviews SET ${sets.join(', ')}
      WHERE tenant_id=$1 AND id=$2
      RETURNING id,rating,comment,visibility,owner_response,created_at,responded_at`,values)
   })
   if(!result.rows[0])fail(404,'review_not_found')
   send(response,200,{review:result.rows[0]});return true
  }
  return false
 }catch(error){send(response,error.statusCode||500,{error:error.statusCode?error.message:'restaurant_reviews_failed'});return true}
}
