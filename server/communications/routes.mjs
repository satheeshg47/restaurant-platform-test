const MAX_BODY_BYTES = 16 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('payload too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch {
    const error = new Error('invalid json')
    error.statusCode = 400
    throw error
  }
}

async function listOwnerTenants(database, identity) {
  const result = await database.query(
    `SELECT DISTINCT t.id AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug
     FROM platform_users pu
     JOIN tenant_memberships tm ON tm.user_id = pu.id
     JOIN tenants t ON t.id = tm.tenant_id
     WHERE pu.auth_provider = $1 AND pu.auth_subject = $2
       AND tm.role = 'owner' AND tm.status = 'active' AND t.status = 'active'
     ORDER BY t.name, t.id`,
    [identity.issuer, identity.subject],
  )
  return result.rows
}

async function identifyOwner(database, identity, tenantId = null) {
  const result = await database.query(
    `SELECT pu.id AS user_id, tm.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug
     FROM platform_users pu
     JOIN tenant_memberships tm ON tm.user_id = pu.id
     JOIN tenants t ON t.id = tm.tenant_id
     WHERE pu.auth_provider = $1 AND pu.auth_subject = $2
       AND tm.role = 'owner' AND tm.status = 'active' AND t.status = 'active'
       AND ($3::uuid IS NULL OR tm.tenant_id = $3::uuid)
     ORDER BY tm.created_at ASC, tm.tenant_id
     LIMIT 2`,
    [identity.issuer, identity.subject, tenantId],
  )
  if (!tenantId && result.rows.length > 1) {
    const error = new Error('Tenant selection required')
    error.statusCode = 409
    throw error
  }
  return result.rows[0] ?? null
}

export async function handleCommunications(request, response, {
  database = null, authenticateAdmin = null, authenticateIdentity = null,
} = {}) {
  const url = new URL(request.url, 'http://localhost')
  const path = url.pathname
  const isAdmin = path.startsWith('/admin/communications')
  const authenticate = isAdmin ? authenticateAdmin : authenticateIdentity
  if (!authenticate) return send(response, 503, { error: isAdmin ? 'admin_auth_not_configured' : 'owner_auth_not_configured' })
  let identity
  try { identity = await authenticate(request) }
  catch (error) { return send(response, error.statusCode === 403 ? 403 : 401, { error: error.statusCode === 403 ? 'forbidden' : 'unauthorized' }) }
  if (!database) return send(response, 503, { error: 'database_not_configured' })

  const parts = path.split('/').filter(Boolean)
  if (!isAdmin && path === '/owner/communications/tenants' && request.method === 'GET') {
    try {
      const tenants = await listOwnerTenants(database, identity)
      return send(response, 200, { tenants })
    } catch { return send(response, 500, { error: 'owner_tenants_list_failed' }) }
  }

  const requestedTenantId = isAdmin ? null : url.searchParams.get('tenant_id')
  if (requestedTenantId && !UUID.test(requestedTenantId)) {
    return send(response, 400, { error: 'invalid_tenant_id' })
  }
  let owner = null
  if (!isAdmin) {
    try { owner = await identifyOwner(database, identity, requestedTenantId) }
    catch (error) {
      if (error.statusCode === 409) return send(response, 409, { error: 'tenant_selection_required' })
      return send(response, 500, { error: 'owner_lookup_failed' })
    }
    if (!owner) return send(response, 403, { error: 'active_owner_required' })
  }
  const conversationId = parts[2] && parts[2] !== 'owners' ? parts[2] : null
  if (isAdmin && request.method === 'GET' && parts[2] === 'owners') {
    try {
      const result = await database.query(
        `SELECT pu.id AS user_id, pu.email,
           array_agg(DISTINCT t.name ORDER BY t.name) AS tenant_names
         FROM platform_users pu
         JOIN tenant_memberships tm ON tm.user_id = pu.id
         JOIN tenants t ON t.id = tm.tenant_id
         WHERE tm.role = 'owner' AND tm.status = 'active' AND t.status = 'active'
         GROUP BY pu.id, pu.email
         ORDER BY pu.email NULLS LAST, pu.id`,
      )
      return send(response, 200, { owners: result.rows })
    } catch { return send(response, 500, { error: 'owner_list_failed' }) }
  }

  if (request.method === 'GET' && !conversationId) {
    try {
      const result = isAdmin
        ? await database.query(
          `SELECT c.id, c.kind, c.subject, c.status, c.created_at, c.updated_at,
             (SELECT body FROM communication_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
             (SELECT count(*)::int FROM communication_participants p WHERE p.conversation_id=c.id) AS participant_count,
             (SELECT count(*)::int FROM communication_messages m WHERE m.conversation_id=c.id AND m.sender_role='owner' AND m.created_at > COALESCE((SELECT max(am.created_at) FROM communication_messages am WHERE am.conversation_id=c.id AND am.sender_role='admin'), c.created_at)) AS unread_count
           FROM communication_conversations c ORDER BY c.updated_at DESC LIMIT 200`,
        )
        : await database.query(
          `SELECT c.id, c.kind, c.subject, c.status, c.created_at, c.updated_at,
             (SELECT body FROM communication_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
             (SELECT count(*)::int FROM communication_messages m WHERE m.conversation_id=c.id AND m.sender_role='admin' AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)) AS unread_count
           FROM communication_conversations c
           JOIN communication_participants p ON p.conversation_id=c.id
           WHERE p.user_id=$1
             AND (p.tenant_id=$2 OR (p.tenant_id IS NULL AND c.kind IN ('group','announcement')))
           ORDER BY c.updated_at DESC LIMIT 100`,
          [owner.user_id, owner.tenant_id],
        )
      return send(response, 200, { conversations: result.rows })
    } catch { return send(response, 500, { error: 'conversations_list_failed' }) }
  }

  if (!isAdmin && request.method === 'POST' && !conversationId) {
    let body
    try { body = await readBody(request) } catch (error) { return send(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'payload_too_large' : 'invalid_json' }) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(response, 400, { error: 'invalid_conversation' })
    const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(response, 400, { error: 'invalid_message' })
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!subject || subject.length > 180 || !message || message.length > 5000) return send(response, 400, { error: 'invalid_conversation' })
    try {
      const result = await database.query(
        `WITH c AS (
           INSERT INTO communication_conversations(kind, subject, created_by_role, created_by_subject)
           VALUES ('support', $1, 'owner', $2) RETURNING id
         ), p AS (
           INSERT INTO communication_participants(conversation_id, user_id, tenant_id)
           SELECT c.id, $3, $4 FROM c RETURNING conversation_id
         ), m AS (
           INSERT INTO communication_messages(conversation_id, sender_role, sender_subject, sender_user_id, body)
           SELECT c.id, 'owner', $2, $3, $5 FROM c RETURNING id, conversation_id, body, created_at
         )
         SELECT m.id, m.conversation_id, m.body, m.created_at FROM m`,
        [subject, identity.subject, owner.user_id, owner.tenant_id, message],
      )
      return send(response, 201, { message: result.rows[0] })
    } catch { return send(response, 500, { error: 'conversation_create_failed' }) }
  }

  if (conversationId && request.method === 'GET') {
    try {
      const access = isAdmin
        ? await database.query('SELECT id FROM communication_conversations WHERE id=$1', [conversationId])
        : await database.query(
          `SELECT c.id FROM communication_conversations c
           JOIN communication_participants p ON p.conversation_id=c.id
           WHERE c.id=$1 AND p.user_id=$2
             AND (p.tenant_id=$3 OR (p.tenant_id IS NULL AND c.kind IN ('group','announcement')))`,
          [conversationId, owner.user_id, owner.tenant_id],
        )
      if (!access.rows.length) return send(response, 404, { error: 'conversation_not_found' })
      const result = await database.query(
        `SELECT id, sender_role, sender_subject, body, created_at
         FROM communication_messages WHERE conversation_id=$1 ORDER BY created_at ASC, id ASC LIMIT 500`,
        [conversationId],
      )
      if (!isAdmin) await database.query(
        'UPDATE communication_participants SET last_read_at=now() WHERE conversation_id=$1 AND user_id=$2 AND (tenant_id=$3 OR tenant_id IS NULL)',
        [conversationId, owner.user_id, owner.tenant_id],
      )
      return send(response, 200, { messages: result.rows })
    } catch { return send(response, 500, { error: 'messages_list_failed' }) }
  }

  if (conversationId && request.method === 'POST' && parts[3] === 'messages') {
    let body
    try { body = await readBody(request) } catch (error) { return send(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'payload_too_large' : 'invalid_json' }) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(response, 400, { error: 'invalid_message' })
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message || message.length > 5000) return send(response, 400, { error: 'invalid_message' })
    try {
      const access = isAdmin
        ? await database.query('SELECT id FROM communication_conversations WHERE id=$1', [conversationId])
        : await database.query(
          `SELECT c.id FROM communication_conversations c
           JOIN communication_participants p ON p.conversation_id=c.id
           WHERE c.id=$1 AND p.user_id=$2
             AND (p.tenant_id=$3 OR (p.tenant_id IS NULL AND c.kind IN ('group','announcement')))`,
          [conversationId, owner.user_id, owner.tenant_id],
        )
      if (!access.rows.length) return send(response, 404, { error: 'conversation_not_found' })
      const result = await database.query(
        `WITH inserted AS (
          INSERT INTO communication_messages(conversation_id, sender_role, sender_subject, sender_user_id, body)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, conversation_id, sender_role, sender_subject, body, created_at
        ), touched AS (
          UPDATE communication_conversations SET updated_at=now(), status=CASE WHEN $2='admin' AND status='resolved' THEN 'in_progress' ELSE status END
          WHERE id=$1 RETURNING id
        )
        SELECT inserted.* FROM inserted JOIN touched ON touched.id=inserted.conversation_id`,
        [conversationId, isAdmin ? 'admin' : 'owner', identity.subject, owner?.user_id ?? null, message],
      )
      return send(response, 201, { message: result.rows[0] })
    } catch { return send(response, 500, { error: 'message_send_failed' }) }
  }

  if (isAdmin && conversationId && request.method === 'PATCH') {
    let body
    try { body = await readBody(request) } catch (error) { return send(response, error.statusCode || 400, { error: 'invalid_json' }) }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !['open', 'in_progress', 'resolved'].includes(body.status)) return send(response, 400, { error: 'invalid_status' })
    try {
      const result = await database.query(
        'UPDATE communication_conversations SET status=$2, updated_at=now() WHERE id=$1 RETURNING id, status',
        [conversationId, body.status],
      )
      return result.rows.length ? send(response, 200, { conversation: result.rows[0] }) : send(response, 404, { error: 'conversation_not_found' })
    } catch { return send(response, 500, { error: 'conversation_update_failed' }) }
  }

  if (isAdmin && request.method === 'POST' && !conversationId) {
    let body
    try { body = await readBody(request) } catch (error) { return send(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'payload_too_large' : 'invalid_json' }) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(response, 400, { error: 'invalid_group_or_announcement' })
    const kind = body.kind
    const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    const userIds = Array.isArray(body.user_ids) ? [...new Set(body.user_ids.filter(id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))] : []
    if (!['group', 'announcement'].includes(kind) || !subject || subject.length > 180 || !message || message.length > 5000 || userIds.length < 1 || userIds.length > 200) return send(response, 400, { error: 'invalid_group_or_announcement' })
    try {
      const result = await database.query(
        `WITH selected AS (
          SELECT DISTINCT pu.id FROM platform_users pu JOIN tenant_memberships tm ON tm.user_id=pu.id
          WHERE pu.id = ANY($1::uuid[]) AND tm.role='owner' AND tm.status='active'
        ), created AS (
          INSERT INTO communication_conversations(kind, subject, created_by_role, created_by_subject)
          SELECT $2, $3, 'admin', $4 WHERE EXISTS (SELECT 1 FROM selected) RETURNING id
        ), participants AS (
          INSERT INTO communication_participants(conversation_id, user_id)
          SELECT created.id, selected.id FROM created CROSS JOIN selected
          RETURNING user_id
        ), message AS (
          INSERT INTO communication_messages(conversation_id, sender_role, sender_subject, body)
          SELECT created.id, 'admin', $4, $5 FROM created RETURNING id, conversation_id
        )
        SELECT message.id, message.conversation_id, (SELECT count(*)::int FROM participants) AS recipient_count FROM message`,
        [userIds, kind, subject, identity.subject, message],
      )
      if (!result.rows[0]?.recipient_count) return send(response, 400, { error: 'no_active_owners_selected' })
      return send(response, 201, { conversation: result.rows[0] })
    } catch { return send(response, 500, { error: 'group_create_failed' }) }
  }

  response.setHeader('Allow', 'GET, POST, PATCH')
  return send(response, 405, { error: 'method_not_allowed' })
}
