import test from 'node:test'
import assert from 'node:assert/strict'
import { handleRestaurantRefund } from './refunds.mjs'

const tenantId = '123e4567-e89b-42d3-a456-426614174000'
const sessionId = '123e4567-e89b-42d3-a456-426614174001'
const orderId = '123e4567-e89b-42d3-a456-426614174002'

function response() {
  return { status: 0, body: null, writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
}
function request(body) {
  return { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
}
function database({ totals = { due: '10000', paid: '7000', paid_refunds: '0', waived: '0' } } = {}) {
  const queries = []
  const client = {
    async query(sql) {
      queries.push(sql)
      if (sql.includes('FROM restaurant_table_sessions')) return { rows: [{ id: sessionId }] }
      if (sql.includes('AS due')) return { rows: [totals] }
      if (sql.includes('FROM restaurant_orders')) return { rows: [{ id: orderId, total_minor: '10000' }] }
      if (sql.includes('INSERT INTO restaurant_refunds')) return { rows: [{ id: 'refund-1', amount_minor: '1000', was_paid: true }] }
      return { rows: [] }
    },
    release() {},
  }
  return { connect: async () => client, queries }
}
const parts = ['restaurant', 'demo', 'waiter', 'sessions', sessionId, 'refunds']

test('refund route records a tenant-scoped paid refund and returns recalculated balance', async () => {
  const db = database()
  const res = response()
  await handleRestaurantRefund(request({ order_id: orderId, amount_minor: '1000', reason: 'Item returned', was_paid: true }), res,
    { database: db, tenantId, actor: { role: 'waiter', staffId: 'staff-1' }, parts })
  assert.equal(res.status, 201)
  assert.equal(res.body.refund.id, 'refund-1')
  assert.equal(res.body.balance_minor, '4000')
  assert.ok(db.queries.some(sql => sql.includes('app.tenant_id')))
  assert.ok(db.queries.some(sql => sql.includes('waiter.refund_recorded')))
})

test('paid refund cannot exceed net recorded payments', async () => {
  const res = response()
  await handleRestaurantRefund(request({ order_id: orderId, amount_minor: '7001', reason: 'Return', was_paid: true }), res,
    { database: database(), tenantId, actor: { role: 'owner', staffId: 'staff-1' }, parts })
  assert.equal(res.status, 409)
  assert.deepEqual(res.body, { error: 'refund_exceeds_net_paid' })
})

test('unpaid waiver cannot exceed the outstanding balance', async () => {
  const res = response()
  await handleRestaurantRefund(request({ order_id: orderId, amount_minor: '3001', reason: 'Unavailable item', was_paid: false }), res,
    { database: database(), tenantId, actor: { role: 'waiter', staffId: 'staff-1' }, parts })
  assert.equal(res.status, 409)
  assert.deepEqual(res.body, { error: 'waiver_exceeds_outstanding_balance' })
})

test('cook cannot record refunds', async () => {
  const res = response()
  await handleRestaurantRefund(request({}), res,
    { database: {}, tenantId, actor: { role: 'cook' }, parts })
  assert.equal(res.status, 403)
  assert.deepEqual(res.body, { error: 'restaurant_role_forbidden' })
})
