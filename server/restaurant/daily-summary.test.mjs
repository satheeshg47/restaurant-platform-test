import test from 'node:test'
import assert from 'node:assert/strict'
import { handleRestaurantDailySummary } from './daily-summary.mjs'

const tenantId = '123e4567-e89b-42d3-a456-426614174000'
function response() { return { status:0, body:null, writeHead(status){this.status=status}, end(body){this.body=JSON.parse(body)} } }
function database() {
  const calls=[]
  return { calls, async connect(){ return {
    async query(sql, values) {
      calls.push({sql,values})
      if (sql.includes('count(*) FILTER')) return {rows:[{order_count:3,cancelled_count:1,revenue_minor:'9000',tax_minor:'400'}]}
      if (sql.includes('GROUP BY method')) return {rows:[{method:'cash',payment_count:2,amount_minor:'6000'}]}
      if (sql.includes('refund_count')) return {rows:[{refund_count:1,refunds_minor:'500'}]}
      if (sql.includes('GROUP BY oi.item_name_snapshot')) return {rows:[{item_name_snapshot:'Masala Dosa',variant_name_snapshot:'',quantity:3,sales_minor:'9000'}]}
      if (sql.includes('INSERT INTO restaurant_daily_summaries')) return {rows:[{business_date:'2026-11-16',order_count:3,revenue_minor:'9000',tax_minor:'400',cancelled_count:1,refunds_minor:'500',average_order_minor:'3000',metrics:{payments:[{method:'cash'}],refund_count:1,top_items:[]},updated_at:'2026-11-17T00:00:00Z'}]}
      if (sql.includes('FROM restaurant_daily_summaries')) return {rows:[{business_date:'2026-11-16',order_count:3,revenue_minor:'9000',tax_minor:'400',cancelled_count:1,refunds_minor:'500',average_order_minor:'3000',metrics:{payments:[]},updated_at:'2026-11-17T00:00:00Z'}]}
      return {rows:[]}
    }, release(){}
  }}}
}
const url = new URL('http://localhost/restaurant/cafe/daily-summary?date=2026-11-16')

test('owner can archive a tenant-scoped daily summary',async()=>{
 const db=database(),res=response()
 await handleRestaurantDailySummary({method:'POST'},res,{database:db,tenantId,actor:{role:'owner'},url})
 assert.equal(res.status,200);assert.equal(res.body.archived,true)
 assert.equal(res.body.summary.revenue_minor,'9000')
 assert.equal(res.body.summary.average_order_minor,'3000')
 assert.ok(db.calls.some(call=>call.sql.includes('INSERT INTO restaurant_daily_summaries')&&call.values[0]===tenantId))
 assert.ok(db.calls.filter(call=>call.sql.includes('FROM restaurant_')).every(call=>call.sql.includes('tenant_id=$1')&&call.values[0]===tenantId))
})

test('owner can retrieve an archived summary without recomputing',async()=>{
 const db=database(),res=response()
 await handleRestaurantDailySummary({method:'GET'},res,{database:db,tenantId,actor:{role:'owner'},url})
 assert.equal(res.status,200);assert.equal(res.body.archived,false)
 assert.equal(res.body.summary.business_date,'2026-11-16')
 assert.equal(db.calls.filter(call=>call.sql.includes('FROM restaurant_')).length,1)
})

test('waiter cannot access daily summaries',async()=>{
 const res=response();let connected=false
 await handleRestaurantDailySummary({method:'POST'},res,{database:{connect:async()=>{connected=true}},tenantId,actor:{role:'waiter'},url})
 assert.equal(res.status,403);assert.equal(connected,false)
})

test('rejects invalid and future business dates before database access',async()=>{
 for(const date of ['2026-02-30','2999-01-01']){
  const res=response();let connected=false
  await handleRestaurantDailySummary({method:'POST'},res,{database:{connect:async()=>{connected=true}},tenantId,actor:{role:'owner'},url:new URL('http://localhost/restaurant/cafe/daily-summary?date='+date)})
  assert.equal(res.status,400);assert.equal(connected,false)
 }
})
