import test from 'node:test'
import assert from 'node:assert/strict'
import { financialYear, handleRestaurantInvoice } from './invoices.mjs'

function response() {
  return { status: 0, body: null, writeHead(status) { this.status = status }, end(value) { this.body = JSON.parse(value) } }
}

test('financial year follows the Asia/Kolkata April boundary', () => {
  assert.equal(financialYear(new Date('2026-03-30T18:29:00.000Z')), '25-26')
  assert.equal(financialYear(new Date('2026-03-31T18:30:00.000Z')), '26-27')
  assert.equal(financialYear(new Date('2027-02-01T00:00:00.000Z')), '26-27')
})

test('cook cannot issue a restaurant GST invoice', async () => {
  const res = response()
  await handleRestaurantInvoice({ method: 'POST' }, res, {
    database: {}, tenantId: '123e4567-e89b-42d3-a456-426614174000',
    actor: { role: 'cook' }, sessionId: '123e4567-e89b-42d3-a456-426614174001',
  })
  assert.equal(res.status, 403)
  assert.deepEqual(res.body, { error: 'restaurant_role_forbidden' })
})

test('malformed session ID is rejected before database access', async () => {
  let connected = false
  const res = response()
  await handleRestaurantInvoice({ method: 'POST' }, res, {
    database: { connect: async () => { connected = true } },
    tenantId: '123e4567-e89b-42d3-a456-426614174000',
    actor: { role: 'owner' }, sessionId: 'bad-id',
  })
  assert.equal(res.status, 404)
  assert.equal(connected, false)
})
