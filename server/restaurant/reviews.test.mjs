import test from 'node:test'
import assert from 'node:assert/strict'
import { handleRestaurantReviews } from './reviews.mjs'
const tenantId='123e4567-e89b-42d3-a456-426614174000'
const reviewId='223e4567-e89b-42d3-a456-426614174000'
function response(){return{status:0,body:null,writeHead(s){this.status=s},end(s){this.body=JSON.parse(s)}}}
function db(rows=[{id:reviewId,rating:5,visibility:'published',owner_response:null}]){
 const calls=[]
 return{calls,async connect(){return{async query(sql,values){calls.push({sql,values});return{rows}},release(){}}}}
}
test('owner can list reviews scoped to tenant',async()=>{
 const database=db(),res=response()
 await handleRestaurantReviews({method:'GET'},res,{database,tenantId,actor:{role:'owner'},parts:['restaurant','cafe','reviews']})
 assert.equal(res.status,200);assert.equal(res.body.reviews.length,1)
 const query=database.calls.find(call=>call.sql.includes('FROM restaurant_reviews r'));assert.ok(query);assert.ok(query.sql.includes('r.tenant_id=$1'));assert.equal(query.values[0],tenantId)
})
test('owner can hide a review and save a public response',async()=>{
 const database=db(),res=response()
 const request={method:'PATCH',async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({visibility:'hidden',owner_response:'Thank you'}))}}
 await handleRestaurantReviews(request,res,{database,tenantId,actor:{role:'owner',staffId:'323e4567-e89b-42d3-a456-426614174000'},parts:['restaurant','cafe','reviews',reviewId]})
 assert.equal(res.status,200);const query=database.calls.find(call=>call.sql.includes('UPDATE restaurant_reviews'));assert.ok(query);assert.ok(query.sql.includes('visibility=$3'));assert.ok(query.sql.includes('owner_response=$4'))
})
test('waiter cannot access review management',async()=>{
 let connected=false;const res=response()
 await handleRestaurantReviews({method:'GET'},res,{database:{connect:async()=>{connected=true}},tenantId,actor:{role:'waiter'},parts:['restaurant','cafe','reviews']})
 assert.equal(res.status,403);assert.equal(connected,false)
})
test('invalid visibility is rejected before database access',async()=>{
 let connected=false;const res=response()
 const request={method:'PATCH',async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({visibility:'public'}))}}
 await handleRestaurantReviews(request,res,{database:{connect:async()=>{connected=true}},tenantId,actor:{role:'owner'},parts:['restaurant','cafe','reviews',reviewId]})
 assert.equal(res.status,400);assert.equal(connected,false)
})
