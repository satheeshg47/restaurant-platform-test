import { randomUUID } from 'node:crypto'
import { withTenantTransaction } from '../db/pool.mjs'

const TABLE = /^restaurant_[a-z0-9_]+$/
const EXCLUDED_COLUMNS = new Set(['password_hash','public_token_hash','photo_object_key','idempotency_key'])
const MAX_ROWS = 50000

function fail(statusCode, code) { const error = new Error(code); error.statusCode = statusCode; throw error }
function csvCell(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  const numeric = typeof value === 'number' || typeof value === 'bigint' || /^-?[0-9]+(?:[.][0-9]+)?$/.test(text)
  if (!numeric && (['=', '+', '-', '@'].includes(text[0]) || text.charCodeAt(0) === 9 || text.charCodeAt(0) === 13)) text = "'" + text
  return '"' + text.replace(/"/g, '""') + '"'
}
function quoteIdentifier(value) { return '"' + value.replace(/"/g, '""') + '"' }

async function withTenantSnapshot(pool, tenantId, operation) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
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


const MAX_BACKUP_BYTES = 50 * 1024 * 1024
const MAX_BACKUP_TABLES = 200
const SAFE_BACKUP_COLUMN = /^[a-z][a-z0-9_]*$/

async function readBackupBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BACKUP_BYTES) fail(413, 'backup_file_too_large')
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_backup_file')
    return value
  } catch (error) {
    if (error.statusCode) throw error
    fail(400, 'invalid_backup_file')
  }
}

async function inspectRestoreReadiness(database, tenantId, backup) {
  const validation = await validateBackup(database, tenantId, backup)
  const tables = await withTenantSnapshot(database, tenantId, async client => {
    const results = []
    for (const tableName of validation.tables) {
      const count = await client.query(
        `SELECT count(*)::text AS row_count FROM public.${quoteIdentifier(tableName)} WHERE tenant_id=$1`,
        [tenantId],
      )
      results.push({ table: tableName, existing_rows: Number(count.rows[0]?.row_count ?? 0) })
    }
    return results
  })
  const nonEmpty = tables.filter(table => table.existing_rows > 0).map(table => table.table)
  return {
    valid: true,
    restore_allowed: nonEmpty.length === 0,
    table_count: validation.table_count,
    backup_row_count: validation.row_count,
    target_tables: tables.length,
    non_empty_tables: nonEmpty,
    message: nonEmpty.length
      ? 'Restore is blocked because the target tenant already contains data. No records were changed.'
      : 'Target tenant tables are empty. This is a preliminary check only; the final restore must revalidate inside its own transaction.',
  }
}

async function validateBackupOnClient(client, tenantId, backup) {
  if (backup.format !== 'platform-core-restaurant-backup' || backup.version !== 1) fail(400, 'unsupported_backup_format')
  if (backup.tenant_id !== tenantId) fail(403, 'backup_tenant_mismatch')
  if (typeof backup.created_at !== 'string' || !Number.isFinite(Date.parse(backup.created_at))) fail(400, 'invalid_backup_timestamp')
  if (!backup.tables || typeof backup.tables !== 'object' || Array.isArray(backup.tables)) fail(400, 'invalid_backup_tables')
  const names = Object.keys(backup.tables)
  if (!names.length || names.length > MAX_BACKUP_TABLES) fail(400, 'invalid_backup_table_count')
  let totalRows = 0
  const currentTables = await client.query(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema='public' AND left(table_name,11)='restaurant_'
       AND column_name='tenant_id'
     GROUP BY table_name ORDER BY table_name`,
  )
  const expectedNames = currentTables.rows.map(row => row.table_name).filter(name => TABLE.test(name))
  if (expectedNames.length !== names.length || expectedNames.some(name => !Object.hasOwn(backup.tables, name))) {
    fail(400, 'backup_table_manifest_incomplete')
  }
  for (const tableName of names) {
    if (!TABLE.test(tableName)) fail(400, 'invalid_backup_table_name')
    const rows = backup.tables[tableName]
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail(400, 'invalid_backup_table_rows')
    const schema = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1
         AND column_name !~* '(password|secret|token|credential|private_key|access_key|idempotency_key|photo_object_key)'
       ORDER BY ordinal_position`,
      [tableName],
    )
    const allowed = schema.rows.map(row => row.column_name)
    if (!allowed.includes('tenant_id')) fail(400, 'backup_table_not_supported')
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail(400, 'invalid_backup_row')
      const keys = Object.keys(row)
      if (keys.length !== allowed.length || keys.some(key => !SAFE_BACKUP_COLUMN.test(key) || !allowed.includes(key))) {
        fail(400, 'backup_columns_incomplete')
      }
      if (row.tenant_id !== tenantId) fail(403, 'backup_row_tenant_mismatch')
    }
    totalRows += rows.length
    if (totalRows > 100000) fail(413, 'backup_too_large')
  }
  if (backup.table_count !== names.length || backup.row_count !== totalRows) fail(400, 'backup_manifest_mismatch')
  return { valid: true, table_count: names.length, row_count: totalRows, tables: names }
}

async function validateBackup(database, tenantId, backup) {
  return withTenantTransaction(database, tenantId, client => validateBackupOnClient(client, tenantId, backup))
}

async function withTenantRestoreTransaction(pool, tenantId, operation) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
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

function orderRestoreTables(names, dependencyRows) {
  const remaining = new Set(names)
  const parents = new Map(names.map(name => [name, new Set()]))
  for (const row of dependencyRows) {
    if (remaining.has(row.child_table) && remaining.has(row.parent_table) && row.child_table !== row.parent_table) {
      parents.get(row.child_table).add(row.parent_table)
    }
  }
  const ordered = []
  while (remaining.size) {
    const ready = [...remaining].filter(name => [...parents.get(name)].every(parent => !remaining.has(parent))).sort()
    if (!ready.length) fail(409, 'backup_foreign_key_cycle_unsupported')
    for (const name of ready) {
      ordered.push(name)
      remaining.delete(name)
    }
  }
  return ordered
}

async function restoreBackup(database, tenantId, backup, confirmation, slug) {
  if (confirmation !== 'RESTORE ' + slug) fail(400, 'restore_confirmation_mismatch')
  return withTenantRestoreTransaction(database, tenantId, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tenantId])
    const current = await client.query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema='public' AND left(table_name,11)='restaurant_'
         AND column_name='tenant_id'
       GROUP BY table_name ORDER BY table_name`,
    )
    const names = current.rows.map(row => row.table_name).filter(name => TABLE.test(name))
    if (!names.length || names.length > MAX_BACKUP_TABLES) fail(409, 'restore_schema_not_supported')
    // Hold a short write lock over all restaurant tables so another request cannot
    // add tenant rows between the empty-target check and the inserts.
    await client.query('LOCK TABLE ' + names.map(name => 'public.' + quoteIdentifier(name)).join(', ') + ' IN SHARE ROW EXCLUSIVE MODE')
    const validation = await validateBackupOnClient(client, tenantId, backup)
    const occupied = []
    for (const name of validation.tables) {
      const count = await client.query(
        `SELECT count(*)::text AS row_count FROM public.${quoteIdentifier(name)} WHERE tenant_id=$1`,
        [tenantId],
      )
      if (BigInt(count.rows[0]?.row_count ?? '0') > 0n) occupied.push(name)
    }
    if (occupied.length) fail(409, 'restore_target_not_empty')
    const dependencies = await client.query(
      `SELECT DISTINCT child.relname AS child_table, parent.relname AS parent_table
       FROM pg_constraint fk
       JOIN pg_class child ON child.oid=fk.conrelid
       JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace
       JOIN pg_class parent ON parent.oid=fk.confrelid
       JOIN pg_namespace parent_ns ON parent_ns.oid=parent.relnamespace
       WHERE fk.contype='f' AND child_ns.nspname='public' AND parent_ns.nspname='public'
         AND child.relname LIKE 'restaurant_%' AND parent.relname LIKE 'restaurant_%'
         AND child.oid<>parent.oid`,
    )
    const orderedTables = orderRestoreTables(validation.tables, dependencies.rows)
    let restoredRows = 0
    for (const tableName of orderedTables) {
      const rows = backup.tables[tableName]
      if (!rows.length) continue
      const metadata = await client.query(
        `SELECT column_name, is_nullable, column_default, is_identity, is_generated
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
        [tableName],
      )
      const excluded = metadata.rows.filter(column =>
        /password|secret|token|credential|private_key|access_key|idempotency_key|photo_object_key/i.test(column.column_name)
      )
      for (const column of excluded) {
        if (column.column_name === 'idempotency_key' && tableName === 'restaurant_orders') continue
        if (column.is_nullable === 'NO' && !column.column_default && column.is_identity !== 'YES' && column.is_generated !== 'ALWAYS') {
          fail(409, 'backup_missing_required_private_field')
        }
      }
      for (const sourceRow of rows) {
        const row = { ...sourceRow }
        if (tableName === 'restaurant_orders') row.idempotency_key = 'restore-' + randomUUID()
        const columns = Object.keys(row)
        if (!columns.length || columns.some(column => !SAFE_BACKUP_COLUMN.test(column))) fail(400, 'invalid_restore_columns')
        const values = columns.map(column => row[column])
        const placeholders = values.map((_, index) => '$' + (index + 1)).join(',')
        await client.query(
          `INSERT INTO public.${quoteIdentifier(tableName)} (${columns.map(quoteIdentifier).join(',')})
           VALUES (${placeholders})`,
          values,
        )
        restoredRows += 1
      }
    }
    return {
      restored: true,
      table_count: orderedTables.length,
      row_count: restoredRows,
      tables: orderedTables,
      security_note: 'Staff password hashes, QR token hashes, menu photo object keys and order idempotency keys were not restored. Reissue table QR codes and re-upload menu photos as needed.',
    }
  })
}

export async function handleRestaurantDataExport(request, response, { database, tenantId, actor, parts }) {
  try {
    if (actor.role !== 'owner') fail(403, 'restaurant_role_forbidden')
    if (parts.length === 4 && parts[3] === 'validate-backup' && request.method === 'POST') {
      const backup = await readBackupBody(request)
      const result = await validateBackup(database, tenantId, backup)
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(result))
      return true
    }
    if (parts.length === 4 && parts[3] === 'restore-preflight' && request.method === 'POST') {
      const backup = await readBackupBody(request)
      const result = await inspectRestoreReadiness(database, tenantId, backup)
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(result))
      return true
    }
    if (parts.length === 4 && parts[3] === 'restore' && request.method === 'POST') {
      const body = await readBackupBody(request)
      const { confirmation, ...backup } = body
      const result = await restoreBackup(database, tenantId, backup, confirmation, parts[1])
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(result))
      return true
    }
    if (request.method !== 'GET') return false
    if (parts.length === 3) {
      const result = await withTenantTransaction(database, tenantId, client => client.query(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema='public' AND left(table_name,11)='restaurant_'
           AND column_name='tenant_id'
         GROUP BY table_name ORDER BY table_name`,
      ))
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ tables: result.rows.map(row => row.table_name) }))
      return true
    }
    if (parts.length === 4 && parts[3] === 'backup') {
      const backup = await withTenantSnapshot(database, tenantId, async client => {
        const tablesResult = await client.query(
          `SELECT table_name FROM information_schema.columns
           WHERE table_schema='public' AND left(table_name,11)='restaurant_'
             AND column_name='tenant_id'
           GROUP BY table_name ORDER BY table_name`,
        )
        const tables = {}
        let totalRows = 0
        for (const entry of tablesResult.rows) {
          const tableName = entry.table_name
          if (!TABLE.test(tableName)) continue
          const columnsResult = await client.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema='public' AND table_name=$1
               AND column_name !~* '(password|secret|token|credential|private_key|access_key|idempotency_key|photo_object_key)'
             ORDER BY ordinal_position`,
            [tableName],
          )
          const columns = columnsResult.rows.map(row => row.column_name)
          if (!columns.includes('tenant_id') || !columns.length) continue
          const rows = await client.query(
            `SELECT ${columns.map(quoteIdentifier).join(', ')}
             FROM public.${quoteIdentifier(tableName)}
             WHERE tenant_id=$1 LIMIT $2`,
            [tenantId, MAX_ROWS + 1],
          )
          if (rows.rows.length > MAX_ROWS) fail(413, 'backup_table_too_large')
          totalRows += rows.rows.length
          if (totalRows > 100000) fail(413, 'backup_too_large')
          tables[tableName] = rows.rows
        }
        return { tables, table_count: Object.keys(tables).length, row_count: totalRows }
      })
      const document = {
        format: 'platform-core-restaurant-backup',
        version: 1,
        created_at: new Date().toISOString(),
        tenant_id: tenantId,
        ...backup,
        security_note: 'Credential hashes, tokens, secrets, storage object keys and idempotency keys are excluded.',
      }
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="restaurant-backup.json"',
        'Cache-Control': 'no-store',
      })
      const serialized = JSON.stringify(document)
      if (Buffer.byteLength(serialized, 'utf8') > MAX_BACKUP_BYTES) fail(413, 'backup_file_too_large')
      response.end(serialized)
      return true
    }
    if (parts.length !== 4 || !TABLE.test(parts[3])) fail(404, 'export_table_not_found')
    const tableName = parts[3]
    const result = await withTenantTransaction(database, tenantId, async client => {
      const columnsResult = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name <> ALL($2::text[])
         ORDER BY ordinal_position`,
        [tableName, [...EXCLUDED_COLUMNS]],
      )
      const columns = columnsResult.rows.map(row => row.column_name)
      if (!columns.includes('tenant_id') || !columns.length) fail(404, 'export_table_not_found')
      const rows = await client.query(
        `SELECT ${columns.map(quoteIdentifier).join(', ')}
         FROM public.${quoteIdentifier(tableName)}
         WHERE tenant_id=$1 LIMIT $2`,
        [tenantId, MAX_ROWS + 1],
      )
      if (rows.rows.length > MAX_ROWS) fail(413, 'export_table_too_large')
      return { columns, rows: rows.rows }
    })
    const newline = String.fromCharCode(13, 10)
    const csv = [
      result.columns.map(csvCell).join(','),
      ...result.rows.map(row => result.columns.map(column => csvCell(row[column])).join(',')),
    ].join(newline) + newline
    response.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${tableName}.csv"`,
      'Cache-Control': 'no-store',
    })
    response.end(String.fromCharCode(0xfeff) + csv)
    return true
  } catch (error) {
    const status = error.statusCode || 500
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ error: error.statusCode ? error.message : 'restaurant_data_export_failed' }))
    return true
  }
}
