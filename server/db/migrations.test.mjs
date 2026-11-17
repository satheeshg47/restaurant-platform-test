import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from './migrations.mjs'

async function makeDir(files = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'platform-migrations-'))
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content)
  }
  return dir
}

function fakePool({ failOn = null } = {}) {
  const versions = new Set()
  const calls = []
  const client = {
    async query(sql, params = []) {
      const statement = String(sql).trim()
      calls.push({ sql: statement, params })
      if (statement.startsWith('SELECT version FROM platform_schema_migrations')) {
        return { rows: [...versions].map((version) => ({ version })) }
      }
      if (statement.startsWith('INSERT INTO platform_schema_migrations')) {
        versions.add(params[0])
      }
      if (failOn && statement.includes(failOn)) throw new Error('simulated database failure')
      return { rows: [] }
    },
    release() { calls.push({ sql: 'RELEASE' }) },
  }
  return {
    calls,
    versions,
    async connect() { return client },
  }
}

test('applies numbered migrations in order and skips unrelated files', async () => {
  const dir = await makeDir({
    '0002_second.sql': 'SELECT 2;',
    'notes.txt': 'not a migration',
    '0001_first.sql': 'SELECT 1;',
    'bad-name.sql': 'SELECT 3;',
  })
  const pool = fakePool()
  try {
    const result = await runMigrations(pool, { migrationsDir: dir })
    assert.deepEqual(result, { applied: ['0001_first.sql', '0002_second.sql'], skipped: [] })
    assert.deepEqual([...pool.versions], ['0001_first.sql', '0002_second.sql'])
    assert.ok(pool.calls.some((call) => call.sql === 'SELECT pg_advisory_lock(hashtext($1))'))
    assert.ok(pool.calls.some((call) => call.sql === 'SELECT pg_advisory_unlock(hashtext($1))'))
    assert.equal(pool.calls.at(-1).sql, 'RELEASE')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('does not reapply migrations already recorded', async () => {
  const dir = await makeDir({ '0001_first.sql': 'SELECT 1;' })
  const pool = fakePool()
  pool.versions.add('0001_first.sql')
  try {
    const result = await runMigrations(pool, { migrationsDir: dir })
    assert.deepEqual(result, { applied: [], skipped: ['0001_first.sql'] })
    assert.equal(pool.calls.some((call) => call.sql === 'SELECT 1;'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('rolls back a failed migration and does not record it', async () => {
  const dir = await makeDir({ '0001_first.sql': 'SELECT trigger_failure;' })
  const pool = fakePool({ failOn: 'trigger_failure' })
  try {
    await assert.rejects(
      runMigrations(pool, { migrationsDir: dir }),
      /Migration 0001_first.sql failed/
    )
    assert.equal(pool.versions.has('0001_first.sql'), false)
    assert.ok(pool.calls.some((call) => call.sql === 'ROLLBACK'))
    assert.ok(pool.calls.some((call) => call.sql === 'SELECT pg_advisory_unlock(hashtext($1))'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('rejects a missing pool', async () => {
  await assert.rejects(runMigrations(null), /PostgreSQL pool is required/)
})
