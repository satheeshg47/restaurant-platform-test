import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/
const LOCK_NAME = 'platform_core_schema_migrations'

export async function runMigrations(pool, { migrationsDir = path.resolve('database/migrations') } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required')
  }

  const client = await pool.connect()
  const applied = []
  const skipped = []
  let lockAcquired = false

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_NAME])
    lockAcquired = true

    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const names = (await readdir(migrationsDir))
      .filter((name) => MIGRATION_NAME.test(name))
      .sort()

    const existing = await client.query(
      'SELECT version FROM platform_schema_migrations ORDER BY version'
    )
    const appliedVersions = new Set(existing.rows.map((row) => row.version))

    for (const name of names) {
      if (appliedVersions.has(name)) {
        skipped.push(name)
        continue
      }

      const sql = await readFile(path.join(migrationsDir, name), 'utf8')
      if (!sql.trim()) throw new Error(`Migration ${name} is empty`)

      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          'INSERT INTO platform_schema_migrations (version) VALUES ($1)',
          [name]
        )
        await client.query('COMMIT')
        applied.push(name)
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${name} failed: ${error.message}`, { cause: error })
      }
    }

    return { applied, skipped }
  } finally {
    try {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME])
      }
    } finally {
      client.release()
    }
  }
}
