import test from 'node:test'
import assert from 'node:assert/strict'
import { withTenantTransaction } from './pool.mjs'

function fakePool(shouldFail = false) {
  const calls = []
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values })
      if (shouldFail && sql === 'SELECT broken') throw new Error('query failed')
      return { rows: [] }
    },
    release: () => calls.push({ sql: 'RELEASE' }),
  }
  return { calls, connect: async () => client }
}

const tenantId = '123e4567-e89b-42d3-a456-426614174000'

test('sets tenant context transaction-locally before running queries', async () => {
  const pool = fakePool()
  const result = await withTenantTransaction(pool, tenantId, async client => {
    await client.query('SELECT 1')
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.deepEqual(pool.calls.map(call => call.sql), [
    'BEGIN',
    "SELECT set_config('app.tenant_id', $1, true)",
    'SELECT 1',
    'COMMIT',
    'RELEASE',
  ])
  assert.deepEqual(pool.calls[1].values, [tenantId])
})

test('rolls back when an operation fails', async () => {
  const pool = fakePool(true)
  await assert.rejects(
    withTenantTransaction(pool, tenantId, client => client.query('SELECT broken')),
    /query failed/,
  )
  assert.equal(pool.calls.some(call => call.sql === 'ROLLBACK'), true)
  assert.equal(pool.calls.at(-1).sql, 'RELEASE')
})

test('rejects missing or malformed tenant context before connecting', async () => {
  let connected = false
  const pool = { connect: async () => { connected = true; throw new Error('unexpected') } }
  await assert.rejects(withTenantTransaction(pool, 'not-a-uuid', async () => {}), /tenant UUID/)
  assert.equal(connected, false)
})

import { createDatabasePool } from './pool.mjs'

test('requires a database URL before creating a pool', () => {
  assert.throws(() => createDatabasePool({}), /DATABASE_URL/)
})

test('rejects an unsafe database pool size', () => {
  assert.throws(
    () => createDatabasePool({ DATABASE_URL: 'postgres://user:pass@localhost/db', DB_POOL_MAX: '0' }),
    /DB_POOL_MAX/,
  )
})
