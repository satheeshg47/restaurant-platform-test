import test from 'node:test'
import assert from 'node:assert/strict'
import { handleRestaurantDataExport } from './data-export.mjs'

const tenantId='123e4567-e89b-42d3-a456-426614174000'
function response(){return{status:0,headers:{},body:null,writeHead(status,headers){this.status=status;this.headers=headers},end(body){this.body=body}}}
function database(existingRows=0,failInsertAt=Infinity){
 const calls=[];let inserts=0
 return{calls,async connect(){return{async query(sql,values){calls.push({sql,values})
  if(sql.includes('information_schema.columns')&&sql.includes("column_name='tenant_id'"))return{rows:[{table_name:'restaurant_orders'},{table_name:'restaurant_staff'}]}
  if(sql.includes('SELECT DISTINCT child.relname AS child_table'))return{rows:[{child_table:'restaurant_orders',parent_table:'restaurant_staff'}]}
  if(sql.includes('information_schema.columns')){const excluded=sql.includes('!~*')?['password_hash','public_token_hash']:values?.[1]??[];return{rows:[{column_name:'id'},{column_name:'tenant_id'},{column_name:'display_name'},{column_name:'password_hash'},{column_name:'public_token_hash'}].filter(row=>!excluded.includes(row.column_name))}}
  if(sql.includes('count(*)::text AS row_count'))return{rows:[{row_count:String(existingRows)}]}
  if(sql.startsWith('INSERT INTO')){inserts++;if(inserts===failInsertAt)throw new Error('simulated insert failure');return{rows:[]}}
  if(sql.includes('FROM public.'))return{rows:[{id:'1',tenant_id:tenantId,display_name:'A, "Cafe"'}]}
  return{rows:[]}
 },release(){}}}}
}
test('owner can list exportable tenant tables',async()=>{
 const db=database(),res=response()
 await handleRestaurantDataExport({method:'GET'},res,{database:db,tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export']})
 assert.equal(res.status,200);assert.deepEqual(JSON.parse(res.body).tables,['restaurant_orders','restaurant_staff'])
})
test('CSV export is tenant-scoped and excludes credential and QR secrets',async()=>{
 const db=database(),res=response()
 await handleRestaurantDataExport({method:'GET'},res,{database:db,tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','restaurant_staff']})
 assert.equal(res.status,200);assert.match(res.headers['Content-Disposition'],/restaurant_staff.csv/)
 assert.match(res.body,/A, ""Cafe""/)
 assert.doesNotMatch(res.body,/password_hash|public_token_hash/)
 const query=db.calls.find(call=>call.sql.includes('FROM public.'))
 assert.equal(query.values[0],tenantId);assert.ok(query.sql.includes('WHERE tenant_id=$1'))
 const columns=db.calls.find(call=>call.sql.includes('information_schema.columns')&&!call.sql.includes("column_name='tenant_id'"))
 assert.ok(columns.values[1].includes('password_hash'));assert.ok(columns.values[1].includes('public_token_hash'))
})
test('waiter cannot export restaurant data',async()=>{
 let connected=false;const res=response()
 await handleRestaurantDataExport({method:'GET'},res,{database:{connect:async()=>{connected=true}},tenantId,actor:{role:'waiter'},parts:['restaurant','cafe','data-export']})
 assert.equal(res.status,403);assert.equal(connected,false)
})
test('invalid export table names are rejected before database access',async()=>{
 let connected=false;const res=response()
 await handleRestaurantDataExport({method:'GET'},res,{database:{connect:async()=>{connected=true}},tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','restaurant_staff;drop_table']})
 assert.equal(res.status,404);assert.equal(connected,false)
})

test('owner can download a tenant JSON backup without secret columns',async()=>{
 const db=database(),res=response()
 await handleRestaurantDataExport({method:'GET'},res,{database:db,tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','backup']})
 assert.equal(res.status,200)
 assert.match(res.headers['Content-Disposition'],/restaurant-backup.json/)
 const backup=JSON.parse(res.body)
 assert.equal(backup.format,'platform-core-restaurant-backup')
 assert.equal(backup.version,1)
 assert.equal(backup.tenant_id,tenantId)
 assert.equal(backup.table_count,2)
 assert.equal(backup.row_count,2)
 assert.ok(backup.tables.restaurant_orders)
 assert.ok(backup.tables.restaurant_staff)
 assert.doesNotMatch(res.body,/password_hash|public_token_hash/)
 assert.ok(db.calls.filter(call=>call.sql.includes('FROM public.')).every(call=>call.values[0]===tenantId))
 assert.ok(db.calls.some(call=>call.sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
 assert.ok(db.calls.some(call=>call.sql.includes("set_config('app.tenant_id'")))
})

function backupRequest(value){
 return {method:'POST',async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(value))}}
}
function validBackup(){
 return {format:'platform-core-restaurant-backup',version:1,created_at:'2026-11-17T12:00:00.000Z',tenant_id:tenantId,table_count:2,row_count:2,tables:{restaurant_orders:[{id:'order-1',tenant_id:tenantId,display_name:'Order'}],restaurant_staff:[{id:'staff-1',tenant_id:tenantId,display_name:'Owner'}]}}
}
test('owner can validate a tenant backup without changing database records',async()=>{
 const db=database(),res=response()
 await handleRestaurantDataExport(backupRequest(validBackup()),res,{database:db,tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','validate-backup']})
 assert.equal(res.status,200)
 assert.deepEqual(JSON.parse(res.body),{valid:true,table_count:2,row_count:2,tables:['restaurant_orders','restaurant_staff']})
 assert.ok(db.calls.some(call=>call.sql==='COMMIT'))
 assert.ok(!db.calls.some(call=>/INSERT|UPDATE|DELETE/i.test(call.sql)))
})
test('backup validation rejects a backup with an incomplete table manifest',async()=>{
 const backup=validBackup();delete backup.tables.restaurant_orders;backup.table_count=1;backup.row_count=1
 const res=response()
 await handleRestaurantDataExport(backupRequest(backup),res,{database:database(),tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','validate-backup']})
 assert.equal(res.status,400);assert.equal(JSON.parse(res.body).error,'backup_table_manifest_incomplete')
})
test('backup validation rejects a backup belonging to another tenant',async()=>{
 const backup=validBackup();backup.tenant_id='123e4567-e89b-42d3-a456-426614174001'
 const db=database(),res=response()
 await handleRestaurantDataExport(backupRequest(backup),res,{database:db,tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','validate-backup']})
 assert.equal(res.status,403);assert.equal(JSON.parse(res.body).error,'backup_tenant_mismatch')
 assert.equal(db.calls.filter(call=>call.sql.includes('information_schema')).length,0)
 assert.ok(db.calls.some(call=>call.sql==='ROLLBACK'))
})
test('backup validation rejects secret columns and rows assigned to another tenant',async()=>{
 const secret=validBackup();secret.tables.restaurant_staff[0].password_hash='secret'
 const secretResponse=response()
 await handleRestaurantDataExport(backupRequest(secret),secretResponse,{database:database(),tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','validate-backup']})
 assert.equal(secretResponse.status,400)
 const crossTenant=validBackup();crossTenant.tables.restaurant_staff[0].tenant_id='123e4567-e89b-42d3-a456-426614174001'
 const tenantResponse=response()
 await handleRestaurantDataExport(backupRequest(crossTenant),tenantResponse,{database:database(),tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','validate-backup']})
 assert.equal(tenantResponse.status,403)
})

test('restore preflight allows a structurally valid backup when target tables are empty',async()=>{
 const db=database(0),res=response()
 await handleRestaurantDataExport(backupRequest(validBackup()),res,{database:db,tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','restore-preflight']})
 assert.equal(res.status,200)
 const result=JSON.parse(res.body)
 assert.equal(result.valid,true);assert.equal(result.restore_allowed,true)
 assert.equal(result.target_tables,2);assert.deepEqual(result.non_empty_tables,[])
 assert.ok(db.calls.some(call=>call.sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
 assert.ok(!db.calls.some(call=>/INSERT|UPDATE|DELETE/i.test(call.sql)))
})
test('restore preflight blocks a tenant that already has restaurant data',async()=>{
 const db=database(3),res=response()
 await handleRestaurantDataExport(backupRequest(validBackup()),res,{database:db,tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','restore-preflight']})
 assert.equal(res.status,200)
 const result=JSON.parse(res.body)
 assert.equal(result.restore_allowed,false)
 assert.deepEqual(result.non_empty_tables,['restaurant_orders','restaurant_staff'])
 assert.match(result.message,/blocked/)
})
test('waiter cannot run backup restore preflight',async()=>{
 let connected=false;const res=response()
 await handleRestaurantDataExport(backupRequest(validBackup()),res,{database:{connect:async()=>{connected=true}},tenantId,actor:{role:'waiter'},parts:['restaurant','cafe','data-export','restore-preflight']})
 assert.equal(res.status,403);assert.equal(connected,false)
})


test('owner restore inserts a validated backup in a serializable transaction',async()=>{
 const db=database(),res=response()
 const payload={...validBackup(),confirmation:'RESTORE cafe'}
 await handleRestaurantDataExport(backupRequest(payload),res,{database:db,tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','restore']})
 assert.equal(res.status,200)
 const result=JSON.parse(res.body)
 assert.equal(result.restored,true);assert.equal(result.row_count,2)
 assert.ok(db.calls.some(call=>call.sql==='BEGIN ISOLATION LEVEL SERIALIZABLE'))
 assert.ok(db.calls.some(call=>call.sql.startsWith('LOCK TABLE')))
 assert.ok(db.calls.some(call=>call.sql==='COMMIT'))
 const inserts=db.calls.filter(call=>call.sql.startsWith('INSERT INTO'))
 assert.equal(inserts.length,2)
 assert.ok(inserts[0].sql.includes('restaurant_staff'))
 assert.ok(inserts[1].sql.includes('restaurant_orders'))
 assert.match(inserts[1].sql,/idempotency_key/)
})

test('restore requires exact typed confirmation and makes no writes',async()=>{
 const db=database(),res=response()
 await handleRestaurantDataExport(backupRequest({...validBackup(),confirmation:'restore cafe'}),res,{database:db,tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','restore']})
 assert.equal(res.status,400);assert.equal(JSON.parse(res.body).error,'restore_confirmation_mismatch')
 assert.equal(db.calls.filter(call=>call.sql.startsWith('INSERT INTO')).length,0)
})

test('restore refuses to overwrite any existing tenant records',async()=>{
 const db=database(1),res=response()
 await handleRestaurantDataExport(backupRequest({...validBackup(),confirmation:'RESTORE cafe'}),res,{database:db,tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','restore']})
 assert.equal(res.status,409);assert.equal(JSON.parse(res.body).error,'restore_target_not_empty')
 assert.equal(db.calls.filter(call=>call.sql.startsWith('INSERT INTO')).length,0)
 assert.ok(db.calls.some(call=>call.sql==='ROLLBACK'))
})

test('restore rolls back all inserted rows if a later insert fails',async()=>{
 const db=database(0,2),res=response()
 await handleRestaurantDataExport(backupRequest({...validBackup(),confirmation:'RESTORE cafe'}),res,{database:db,tenantId,actor:{role:'owner'},parts:['restaurant','cafe','data-export','restore']})
 assert.equal(res.status,500)
 assert.equal(db.calls.filter(call=>call.sql.startsWith('INSERT INTO')).length,2)
 assert.ok(db.calls.some(call=>call.sql==='ROLLBACK'))
 assert.ok(!db.calls.some(call=>call.sql==='COMMIT'))
})

test('waiter cannot restore restaurant backups',async()=>{
 let connected=false;const res=response()
 await handleRestaurantDataExport(backupRequest({...validBackup(),confirmation:'RESTORE cafe'}),res,{database:{connect:async()=>{connected=true}},tenantId,actor:{role:'waiter'},parts:['restaurant','cafe','data-export','restore']})
 assert.equal(res.status,403);assert.equal(connected,false)
})
