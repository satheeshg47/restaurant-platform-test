const APP_KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/
const MAX_BODY_BYTES = 8192

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('Invalid JSON')
    error.statusCode = 400
    throw error
  }
}

export async function handleAdminApplications(request, response, {
  database = null,
  authenticateAdmin = null,
} = {}) {
  if (!authenticateAdmin) {
    send(response, 503, { error: 'admin_auth_not_configured' })
    return
  }

  let admin
  try {
    admin = await authenticateAdmin(request)
  } catch (error) {
    const status = error.statusCode === 403 ? 403 : 401
    send(response, status, { error: status === 403 ? 'forbidden' : 'unauthorized' })
    return
  }

  if (!database) {
    send(response, 503, { error: 'database_not_configured' })
    return
  }

  if (request.method === 'GET') {
    try {
      const result = await database.query(
        'SELECT id, app_key, name, status, created_at, updated_at FROM applications ORDER BY created_at DESC',
      )
      send(response, 200, { applications: result.rows })
    } catch {
      send(response, 500, { error: 'application_list_failed' })
    }
    return
  }

  if (request.method === 'POST') {
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      send(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'payload_too_large' : 'invalid_json' })
      return
    }

    const appKey = typeof body?.app_key === 'string' ? body.app_key.trim() : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!APP_KEY_PATTERN.test(appKey) || name.length < 1 || name.length > 160) {
      send(response, 400, { error: 'invalid_application' })
      return
    }

    if (typeof admin?.issuer !== 'string' || typeof admin?.subject !== 'string') {
      send(response, 500, { error: 'admin_identity_unavailable' })
      return
    }

    try {
      // One SQL statement makes creation + audit logging atomic: either both
      // records commit, or neither does.
      const result = await database.query(
        `WITH created AS (
          INSERT INTO applications (app_key, name)
          VALUES ($1, $2)
          RETURNING id, app_key, name, status, created_at, updated_at
        ), audited AS (
          INSERT INTO platform_audit_events
            (actor_issuer, actor_subject, action, resource_type, resource_id, metadata)
          SELECT $3, $4, 'application.created', 'application', created.id::text,
            jsonb_build_object('app_key', created.app_key, 'name', created.name)
          FROM created
          RETURNING id
        )
        SELECT created.id, created.app_key, created.name, created.status,
          created.created_at, created.updated_at
        FROM created CROSS JOIN audited`,
        [appKey, name, admin.issuer, admin.subject],
      )
      send(response, 201, { application: result.rows[0] })
    } catch (error) {
      if (error.code === '23505') {
        send(response, 409, { error: 'application_key_exists' })
      } else {
        send(response, 500, { error: 'application_create_failed' })
      }
    }
    return
  }

  response.setHeader('Allow', 'GET, POST')
  send(response, 405, { error: 'method_not_allowed' })
}
