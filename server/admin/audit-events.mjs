function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

export async function handleAdminAuditEvents(request, response, {
  database = null,
  authenticateAdmin = null,
} = {}) {
  if (!authenticateAdmin) {
    send(response, 503, { error: 'admin_auth_not_configured' })
    return
  }

  try {
    await authenticateAdmin(request)
  } catch (error) {
    const status = error.statusCode === 403 ? 403 : 401
    send(response, status, { error: status === 403 ? 'forbidden' : 'unauthorized' })
    return
  }

  if (!database) {
    send(response, 503, { error: 'database_not_configured' })
    return
  }

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    send(response, 405, { error: 'method_not_allowed' })
    return
  }

  const url = new URL(request.url, 'http://localhost')
  const rawLimit = url.searchParams.get('limit')
  const rawOffset = url.searchParams.get('offset')
  const limit = rawLimit === null ? 25 : Number(rawLimit)
  const offset = rawOffset === null ? 0 : Number(rawOffset)

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
    send(response, 400, { error: 'invalid_pagination' })
    return
  }

  try {
    const result = await database.query(
      `SELECT id, actor_issuer, actor_subject, action, resource_type,
        resource_id, metadata, created_at, count(*) OVER()::int AS total_count
      FROM platform_audit_events
      ORDER BY created_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
      [limit, offset],
    )
    const total = result.rows.length ? result.rows[0].total_count : 0
    const events = result.rows.map(({ total_count, ...event }) => event)
    send(response, 200, {
      events,
      pagination: { limit, offset, total, has_more: offset + events.length < total },
    })
  } catch {
    send(response, 500, { error: 'audit_events_list_failed' })
  }
}
