import test from 'node:test'
import assert from 'node:assert/strict'
import { handleRestaurantReports } from './reports.mjs'

const tenantId = '123e4567-e89b-42d3-a456-426614174000'
function response() { return { status:0, body:null, writeHead(status){this.status=status}, end(body){this.body=JSON.parse(body)} } }
function database() {
  const calls=[]
  return { calls, async connect(){return { async query(sql,values){calls.push({sql,values});if(sql.includes('count(*)::int AS order_count'))return {rows:[{order_count:4,subtotal_minor:'10000',tax_minor:'500',sales_minor:'10500'}]};if(sql.includes('GROUP BY method'))return {rows:[{method:'cash',amount_minor:'5000',payment_count:2}]};if(sql.includes('refund_count'))return {rows:[{refunded_minor:'200',refund_count:1}]};if(sql.includes('GROUP BY (created_at'))return {rows:[{day:'2026-11-17',order_count:4,sales_minor:'10500',tax_minor:'500'}]};if(sql.includes('GROUP BY oi.item_name_snapshot'))return {rows:[{item_name_snapshot:'Masala Dosa',variant_name_snapshot:'',quantity:3,sales_minor:'7500'}]};return {rows:[]}},release(){}}} }
}
const url = new URL('http://localhost/restaurant/cafe/reports?from=2026-11-17&to=2026-11-17')
test('owner receives tenant-scoped report totals, payment mix and top items',async()=>{
 const db=database(),res=response()
 await handleRestaurantReports({method:'GET'},res,{database:db,tenantId,actor:{role:'owner'},url})
 assert.equal(res.status,200);assert.equal(res.body.summary.sales_minor,'10500')
 assert.equal(res.body.payments[0].method,'cash');assert.equal(res.body.top_items[0].item_name_snapshot,'Masala Dosa')
 const reportQueries=db.calls.filter(call=>call.sql.includes('FROM restaurant_'));assert.equal(reportQueries.length,5);assert.ok(reportQueries.every(call=>call.values?.[0]===tenantId&&call.sql.includes('tenant_id=$1')))
})
test('waiter cannot access owner reports',async()=>{
 const res=response();let connected=false
 await handleRestaurantReports({method:'GET'},res,{database:{connect:async()=>{connected=true}},tenantId,actor:{role:'waiter'},url})
 assert.equal(res.status,403);assert.equal(connected,false)
})
test('report rejects invalid, reversed and oversized date ranges before database access',async()=>{
 for(const query of ['?from=2026-02-30&to=2026-03-01','?from=2026-11-18&to=2026-11-17','?from=2025-01-01&to=2026-11-17']){
  const res=response();let connected=false
  await handleRestaurantReports({method:'GET'},res,{database:{connect:async()=>{connected=true}},tenantId,actor:{role:'owner'},url:new URL('http://localhost/restaurant/cafe/reports'+query)})
  assert.equal(res.status,400);assert.equal(connected,false)
 }
})
