import test from 'node:test'
import assert from 'node:assert/strict'
import { computeBatchStatus, computeOrderStatus } from './kitchen.mjs'

test('order status rolls up item progress in the correct order', () => {
  assert.equal(computeOrderStatus(['new', 'accepted']), 'accepted')
  assert.equal(computeOrderStatus(['preparing', 'ready']), 'preparing')
  assert.equal(computeOrderStatus(['ready', 'served']), 'ready')
  assert.equal(computeOrderStatus(['served', 'served']), 'served')
})

test('order status records partial unavailability while active items remain', () => {
  assert.equal(computeOrderStatus(['unavailable', 'new']), 'partially_unavailable')
  assert.equal(computeOrderStatus(['unavailable', 'served']), 'served')
  assert.equal(computeOrderStatus(['unavailable', 'cancelled']), 'cancelled')
})

test('batch status reflects allocations and completes only after all are terminal', () => {
  assert.equal(computeBatchStatus(['new', 'accepted']), 'accepted')
  assert.equal(computeBatchStatus(['preparing', 'new']), 'preparing')
  assert.equal(computeBatchStatus(['ready', 'served']), 'ready')
  assert.equal(computeBatchStatus(['served', 'unavailable']), 'completed')
  assert.equal(computeBatchStatus(['new']), 'new')
})

test('waiters cannot access the kitchen queue endpoint', async () => {
  const response = {
    status: 0,
    body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(body) },
  }
  const handled = await (await import('./kitchen.mjs')).handleKitchenRoutes(
    { method: 'GET' }, response,
    { database: {}, tenantId: '123e4567-e89b-42d3-a456-426614174000', actor: { role: 'waiter' }, parts: ['restaurant','demo','kitchen','queue'] },
  )
  assert.equal(handled, true)
  assert.equal(response.status, 403)
  assert.deepEqual(response.body, { error: 'restaurant_role_forbidden' })
})

test('malformed order item IDs are rejected before opening a database connection', async () => {
  let connected = false
  const response = {
    status: 0,
    body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(body) },
  }
  const handled = await (await import('./kitchen.mjs')).handleKitchenRoutes(
    { method: 'PATCH' }, response,
    { database: { connect: async () => { connected = true } }, tenantId: '123e4567-e89b-42d3-a456-426614174000', actor: { role: 'cook' }, parts: ['restaurant','demo','kitchen','items','bad-id','status'] },
  )
  assert.equal(handled, true)
  assert.equal(response.status, 404)
  assert.deepEqual(response.body, { error: 'order_item_not_found' })
  assert.equal(connected, false)
})
