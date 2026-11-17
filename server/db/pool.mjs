import pg from 'pg'

const { Pool } = pg

export function createDatabasePool(env = process.env) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required before database access can be enabled')
  }

  const max = Number(env.DB_POOL_MAX ?? 10)
  if (!Number.isInteger(max) || max < 1 || max > 50) {
    throw new Error('DB_POOL_MAX must be an integer between 1 and 50')
  }

  return new Pool({
    connectionString: env.DATABASE_URL,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    application_name: 'platform-core-api',
    ...(env.DATABASE_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
  })
}

export async function withTenantTransaction(pool, tenantId, operation) {
  if (typeof tenantId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new TypeError('A valid authenticated tenant UUID is required')
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
