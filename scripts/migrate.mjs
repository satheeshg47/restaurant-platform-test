import { createDatabasePool } from '../server/db/pool.mjs'
import { runMigrations } from '../server/db/migrations.mjs'

const pool = createDatabasePool()
try {
  const result = await runMigrations(pool)
  for (const name of result.applied) console.log(`Applied: ${name}`)
  for (const name of result.skipped) console.log(`Already applied: ${name}`)
  console.log(`Migration check complete. ${result.applied.length} applied, ${result.skipped.length} already applied.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
