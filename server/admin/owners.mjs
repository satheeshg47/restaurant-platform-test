function send(response,status,body){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(body))}

export async function handleAdminOwners(request,response,{database=null,authenticateAdmin=null}={}){
 if(!authenticateAdmin){send(response,503,{error:'admin_auth_not_configured'});return}
 let admin
 try{admin=await authenticateAdmin(request)}catch(error){const status=error.statusCode===403?403:401;send(response,status,{error:status===403?'forbidden':'unauthorized'});return}
 if(typeof admin?.issuer!=='string'||typeof admin?.subject!=='string'){send(response,403,{error:'admin_identity_unavailable'});return}
 if(!database){send(response,503,{error:'database_not_configured'});return}
 if(request.method!=='GET'){response.setHeader('Allow','GET');send(response,405,{error:'method_not_allowed'});return}
 try{
  const result=await database.query(`
   SELECT t.id AS tenant_id,t.name AS tenant_name,t.slug AS tenant_slug,t.status AS tenant_status,
    t.created_at AS tenant_created_at,pu.id AS user_id,pu.email,
    tm.role,tm.status AS membership_status,tm.created_at AS membership_created_at
   FROM tenants t
   LEFT JOIN tenant_memberships tm ON tm.tenant_id=t.id AND tm.role='owner'
   LEFT JOIN platform_users pu ON pu.id=tm.user_id
   ORDER BY t.created_at DESC,pu.email
  `)
  send(response,200,{owners:result.rows.map(row=>({...row,owner_present:Boolean(row.user_id)}))})
 }catch{send(response,500,{error:'owner_directory_failed'})}
}
