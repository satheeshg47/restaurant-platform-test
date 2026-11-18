import type { Env } from './types.ts'
type Actor={tenantId:string;userId:string;staffId:string|null;role:string}
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})
const PRIVATE_COLUMNS=new Set(['password_hash','public_token_hash','photo_object_key','idempotency_key','secret','secret_hash','api_key','access_token','refresh_token'])
const MAX_BACKUP_BYTES=5*1024*1024
const MAX_BACKUP_ROWS=50000
const MAX_RESTORE_ROWS=500
function fail(status:number,code:string):never{throw Object.assign(new Error(code),{status})}
function quoteIdentifier(value:string){return '"'+value.replace(/"/g,'""')+'"'}
async function schema(env:Env){
 const found=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'restaurant_%' AND name NOT LIKE 'sqlite_%' AND name<>'restaurant_tenant_controls' ORDER BY name").all<{name:string}>()
 const result:{name:string;columns:string[];privateColumns:string[]}[]=[]
 for(const row of found.results){
  if(!/^restaurant_[a-z0-9_]+$/.test(row.name)) continue
  const info=await env.DB.prepare(`PRAGMA table_info(${quoteIdentifier(row.name)})`).all<{name:string}>()
  const columns=info.results.map(x=>x.name)
  if(!columns.includes('tenant_id')) continue
  result.push({name:row.name,columns:columns.filter(x=>!PRIVATE_COLUMNS.has(x)),privateColumns:columns.filter(x=>PRIVATE_COLUMNS.has(x))})
 }
 return result
}
async function makeBackup(env:Env,tenantId:string){
 const tables=await schema(env),data:Record<string,Record<string,unknown>[]>= {}
 let totalRows=0
 for(const table of tables){
  const columns=table.columns.map(quoteIdentifier).join(',')
  const result=await env.DB.prepare(`SELECT ${columns} FROM ${quoteIdentifier(table.name)} WHERE tenant_id=? ORDER BY rowid LIMIT ?`).bind(tenantId,MAX_BACKUP_ROWS+1).all<Record<string,unknown>>()
  if(result.results.length>MAX_BACKUP_ROWS) fail(413,'backup_table_row_limit_exceeded')
  totalRows+=result.results.length
  if(totalRows>MAX_BACKUP_ROWS) fail(413,'backup_row_limit_exceeded')
  data[table.name]=result.results
 }
 const backup={format:'restaurant-platform-d1-backup',version:1,tenant_id:tenantId,created_at:new Date().toISOString(),table_names:tables.map(t=>t.name),row_count:totalRows,tables:data}
 const bytes=new TextEncoder().encode(JSON.stringify(backup)).byteLength
 if(bytes>MAX_BACKUP_BYTES) fail(413,'backup_size_limit_exceeded')
 return backup
}
function csvValue(value:unknown){
 if(value===null||value===undefined)return ''
 let s=typeof value==='string'?value:typeof value==='object'?JSON.stringify(value):String(value)
 if(/^[=+@\-]/.test(s)&&!/^[-+]?\d+(?:\.\d+)?$/.test(s))s="'"+s
 return '"'+s.replace(/"/g,'""')+'"'
}
async function validateBackup(env:Env,tenantId:string,value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value)) fail(400,'invalid_backup')
 const backup=value as Record<string,unknown>
 if(backup.format!=='restaurant-platform-d1-backup'||backup.version!==1||backup.tenant_id!==tenantId||!backup.tables||typeof backup.tables!=='object'||Array.isArray(backup.tables)) fail(400,'backup_identity_or_format_mismatch')
 const tables=await schema(env),expected=tables.map(t=>t.name).sort()
 const names=Array.isArray(backup.table_names)?backup.table_names.filter(x=>typeof x==='string').sort():[]
 if(JSON.stringify(names)!==JSON.stringify(expected)) fail(409,'backup_schema_mismatch')
 const source=backup.tables as Record<string,unknown>
 if(Object.keys(source).sort().join('|')!==expected.join('|')) fail(400,'backup_table_manifest_invalid')
 let rowCount=0
 for(const table of tables){
  const rows=source[table.name]
  if(!Array.isArray(rows)) fail(400,'backup_table_data_invalid')
  const allowed=new Set(table.columns)
  for(const row of rows){
   if(!row||typeof row!=='object'||Array.isArray(row)) fail(400,'backup_row_invalid')
   const record=row as Record<string,unknown>
   if(record.tenant_id!==tenantId||Object.keys(record).some(k=>!allowed.has(k))||table.columns.some(k=>!(k in record))) fail(400,'backup_row_columns_or_tenant_invalid')
   rowCount++
   if(rowCount>MAX_BACKUP_ROWS) fail(413,'backup_row_limit_exceeded')
  }
 }
 const bytes=new TextEncoder().encode(JSON.stringify(value)).byteLength
 if(bytes>MAX_BACKUP_BYTES) fail(413,'backup_size_limit_exceeded')
 if(Number(backup.row_count)!==rowCount) fail(400,'backup_row_count_mismatch')
 return {tables,rowCount,bytes}
}
async function preflight(env:Env,tenantId:string,backup:unknown){
 const valid=await validateBackup(env,tenantId,backup)
 const occupied:string[]=[]
 for(const table of valid.tables){
  const row=await env.DB.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(table.name)} WHERE tenant_id=?`).bind(tenantId).first<{count:number}>()
  if(Number(row?.count||0)>0)occupied.push(table.name)
 }
 const lock=await env.DB.prepare('SELECT maintenance_mode,restore_mode FROM restaurant_tenant_controls WHERE tenant_id=?').bind(tenantId).first<{maintenance_mode:number;restore_mode:number}>()
 if(lock)occupied.push('restaurant_tenant_controls')
 return {valid:true,restore_allowed:occupied.length===0&&valid.rowCount<=MAX_RESTORE_ROWS,blocked_tables:occupied,row_count:valid.rowCount,backup_bytes:valid.bytes,restore_row_limit:MAX_RESTORE_ROWS,tables:valid.tables,private_fields_to_regenerate:['QR table tokens','order idempotency keys'],private_fields_not_restored:['staff password hashes','menu photo object keys']}
}
export async function handleRestaurantDataExport(request:Request,env:Env,actor:Actor,parts:string[]):Promise<Response|null>{
 try{
  if(!['owner','manager','super_admin'].includes(actor.role)) fail(403,'restaurant_role_forbidden')
  if(parts.length===3&&request.method==='GET'){
   const tables=await schema(env)
   return json(200,{tables:tables.map(t=>({name:t.name,exportable_columns:t.columns.length,private_columns_excluded:t.privateColumns})),backup_format_version:1,limits:{max_rows:MAX_BACKUP_ROWS,max_bytes:MAX_BACKUP_BYTES}})
  }
  if(parts.length===4&&parts[3]==='backup'&&request.method==='GET'){
   const backup=await makeBackup(env,actor.tenantId)
   return new Response(JSON.stringify(backup),{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="restaurant-backup.json"','Cache-Control':'no-store'}})
  }
  if(parts.length===4&&parts[3]==='validate-backup'&&request.method==='POST'){
   const raw=await request.text()
   if(new TextEncoder().encode(raw).byteLength>MAX_BACKUP_BYTES)fail(413,'backup_size_limit_exceeded')
   let value:unknown;try{value=JSON.parse(raw)}catch{fail(400,'invalid_backup_json')}
   const result=await validateBackup(env,actor.tenantId,value)
   return json(200,{valid:true,row_count:result.rowCount,backup_bytes:result.bytes,table_count:result.tables.length})
  }
  if(parts.length===4&&parts[3]==='restore-preflight'&&request.method==='POST'){
   const raw=await request.text()
   if(new TextEncoder().encode(raw).byteLength>MAX_BACKUP_BYTES)fail(413,'backup_size_limit_exceeded')
   let value:unknown;try{value=JSON.parse(raw)}catch{fail(400,'invalid_backup_json')}
   const result=await preflight(env,actor.tenantId,value)
   const {tables:ignored,...publicResult}=result
   return json(200,publicResult)
  }
  if(parts.length===4&&parts[3]==='restore'&&request.method==='POST'){
   if(actor.role!=='owner'&&actor.role!=='super_admin')fail(403,'restaurant_role_forbidden')
   const raw=await request.text()
   if(new TextEncoder().encode(raw).byteLength>MAX_BACKUP_BYTES)fail(413,'backup_size_limit_exceeded')
   let value:unknown;try{value=JSON.parse(raw)}catch{fail(400,'invalid_backup_json')}
   if(!value||typeof value!=='object'||(value as Record<string,unknown>).confirmation!==`RESTORE ${parts[1]}`)fail(400,'restore_confirmation_required')
   const check=await preflight(env,actor.tenantId,value)
   if(check.row_count>MAX_RESTORE_ROWS)fail(413,'restore_row_limit_exceeded')
   if(!check.restore_allowed)fail(409,'restore_target_not_empty')
   const backup=value as {tables:Record<string,Record<string,unknown>[]>}
   const statements=[env.DB.prepare('PRAGMA defer_foreign_keys=ON'),env.DB.prepare('INSERT INTO restaurant_tenant_controls(tenant_id,maintenance_mode,restore_mode) VALUES(?,1,1)').bind(actor.tenantId)]
   const regenerated:{table_id:string;qr_token:string}[]=[]
   for(const table of check.tables){
    for(const sourceRow of backup.tables[table.name]){
     const row:Record<string,unknown>={...sourceRow}
     if(table.name==='restaurant_tables'){
      const bytes=new Uint8Array(32);crypto.getRandomValues(bytes)
      const token=btoa(Array.from(bytes,x=>String.fromCharCode(x)).join('')).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))
      row.public_token_hash=[...digest].map(x=>x.toString(16).padStart(2,'0')).join('')
      regenerated.push({table_id:String(row.id),qr_token:token})
     }
     if(table.name==='restaurant_orders')row.idempotency_key='restore-'+crypto.randomUUID()
     const columns=[...table.columns,...table.privateColumns.filter(name=>name==='public_token_hash'&&table.name==='restaurant_tables'||name==='idempotency_key'&&table.name==='restaurant_orders')]
     const values=columns.map(name=>row[name]??null)
     const sql=`INSERT INTO ${quoteIdentifier(table.name)}(${columns.map(quoteIdentifier).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`
     statements.push(env.DB.prepare(sql).bind(...values))
    }
   }
   statements.push(env.DB.prepare('DELETE FROM restaurant_tenant_controls WHERE tenant_id=? AND maintenance_mode=1 AND restore_mode=1').bind(actor.tenantId))
   try{
    await env.DB.batch(statements)
    return json(200,{restored:true,row_count:check.row_count,regenerated_qr_tokens:regenerated,private_fields_not_restored:['staff password hashes','menu photo object keys']})
   }catch(error){
    const message=error instanceof Error?error.message:''
    if(/restore_target_not_empty|UNIQUE constraint failed: restaurant_tenant_controls/i.test(message))fail(409,'restore_target_not_empty')
    throw error
   }
  }
  if(parts.length===4&&/^restaurant_[a-z0-9_]+$/.test(parts[3])&&request.method==='GET'){
   const tables=await schema(env),table=tables.find(t=>t.name===parts[3])
   if(!table)fail(404,'export_table_not_found')
   const result=await env.DB.prepare(`SELECT ${table.columns.map(quoteIdentifier).join(',')} FROM ${quoteIdentifier(table.name)} WHERE tenant_id=? ORDER BY rowid LIMIT 50001`).bind(actor.tenantId).all<Record<string,unknown>>()
   if(result.results.length>50000)fail(413,'csv_export_row_limit_exceeded')
   const header=table.columns.map(csvValue).join(',')
   const lines=result.results.map(row=>table.columns.map(col=>csvValue(row[col])).join(','))
   return new Response([header,...lines].join('\r\n'),{status:200,headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${table.name}.csv"`,'Cache-Control':'no-store'}})
  }
  return null
 }catch(error){return json(error&&typeof error==='object'&&'status'in error?Number(error.status):500,{error:error instanceof Error&&'status'in error?error.message:'restaurant_data_export_failed'})}
}
