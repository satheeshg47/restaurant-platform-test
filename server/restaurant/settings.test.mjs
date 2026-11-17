import test from 'node:test'
import assert from 'node:assert/strict'
import { handleRestaurantSettings } from './settings.mjs'

const tenantId = '123e4567-e89b-42d3-a456-426614174000'
function response() { return { status:0, body:null, writeHead(status){this.status=status}, end(body){this.body=JSON.parse(body)} } }
function req(method, body) { return { method, async *[Symbol.asyncIterator](){ yield Buffer.from(JSON.stringify(body)) } } }
function database(row = { display_name:'Cafe',currency_code:'INR',timezone:'Asia/Kolkata',default_language:'en',tax_mode:'none',tax_rate:'0',gst_rate:'5',tax_inclusive:false,accepting_orders:true }) {
  const calls=[]
  return { calls, async connect(){return { async query(sql,values){calls.push({sql,values});return {rows:sql.includes('RETURNING') || sql.includes('SELECT display_name') ? (row ? [row] : []) : []}},release(){}}} }
}
test('owner can read tenant restaurant settings', async()=>{
 const db=database(),res=response()
 await handleRestaurantSettings({method:'GET'},res,{database:db,tenantId,actor:{role:'owner'}})
 assert.equal(res.status,200);assert.equal(res.body.settings.display_name,'Cafe')
 assert.ok(db.calls.some(call => call.sql.includes('SELECT display_name') && call.sql.includes('WHERE tenant_id=$1')))
})
test('manager can update tax and order acceptance settings', async()=>{
 const db=database(),res=response()
 await handleRestaurantSettings(req('PATCH',{tax_mode:'gst',gst_rate:5,tax_inclusive:true,accepting_orders:false}),res,{database:db,tenantId,actor:{role:'manager'}})
 assert.equal(res.status,200);const update=db.calls.find(call => call.sql.includes('UPDATE restaurant_profiles'))
 assert.ok(update)
 assert.deepEqual(update.values,[tenantId,'gst',5,true,false])
})
test('waiter cannot read or update owner settings',async()=>{
 const res=response()
 await handleRestaurantSettings({method:'GET'},res,{database:{},tenantId,actor:{role:'waiter'}})
 assert.equal(res.status,403);assert.deepEqual(res.body,{error:'restaurant_role_forbidden'})
})
test('settings reject invalid tax rates without database access',async()=>{
 const res=response();let connected=false
 await handleRestaurantSettings(req('PATCH',{tax_rate:101}),res,{database:{connect:async()=>{connected=true}},tenantId,actor:{role:'owner'}})
 assert.equal(res.status,400);assert.equal(connected,false)
})
test('settings reject unknown fields',async()=>{
 const res=response();let connected=false
 await handleRestaurantSettings(req('PATCH',{secret:'no'}),res,{database:{connect:async()=>{connected=true}},tenantId,actor:{role:'owner'}})
 assert.equal(res.status,400);assert.equal(connected,false)
})
