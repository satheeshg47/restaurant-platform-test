import { authenticateAdmin, authenticateIdentity, authStatus } from './auth'
import type { Env, Identity } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STATUSES = ['open', 'in_progress', 'resolved']

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('Content-Length') || 0)
  if (declared > 16384) throw Object.assign(new Error('payload_too_large'), { status: 413 })
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > 16384) throw Object.assign(new Error('payload_too_large'), { status: 413 })
  try {
    const body: unknown = JSON.parse(raw)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid')
    return body as Record<string, unknown>
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 })
  }
}

function bodyError(error: unknown): Response {
  const status = authStatus(error, 400)
  return json(status, { error: status === 413 ? 'payload_too_large' : 'invalid_json' })
}

async function listOwnerTenants(env: Env, identity: Identity) {
  const result = await env.DB.prepare(
    `SELECT DISTINCT t.id AS tenant_id,t.name AS tenant_name,t.slug AS tenant_slug
     FROM platform_users pu
     JOIN tenant_memberships tm ON tm.user_id=pu.id
     JOIN tenants t ON t.id=tm.tenant_id
     WHERE pu.auth_provider=? AND pu.auth_subject=?
       AND tm.role='owner' AND tm.status='active' AND t.status='active'
     ORDER BY t.name,t.id`,
  ).bind(identity.issuer, identity.subject).all()
  return result.results
}

async function identifyOwner(env: Env, identity: Identity, tenantId: string | null) {
  const result = await env.DB.prepare(
    `SELECT pu.id AS user_id,tm.tenant_id,t.name AS tenant_name,t.slug AS tenant_slug
     FROM platform_users pu
     JOIN tenant_memberships tm ON tm.user_id=pu.id
     JOIN tenants t ON t.id=tm.tenant_id
     WHERE pu.auth_provider=? AND pu.auth_subject=?
       AND tm.role='owner' AND tm.status='active' AND t.status='active'
       AND (? IS NULL OR tm.tenant_id=?)
     ORDER BY tm.created_at ASC,tm.tenant_id LIMIT 2`,
  ).bind(identity.issuer, identity.subject, tenantId, tenantId).all<Record<string, unknown>>()
  if (!tenantId && result.results.length > 1) return { conflict: true as const, owner: null }
  return { conflict: false as const, owner: result.results[0] ?? null }
}

export async function handleCommunications(request: Request, env: Env, path: string): Promise<Response> {
  const isAdmin = path.startsWith('/admin/communications')
  const isOwner = path.startsWith('/owner/communications')
  if (!isAdmin && !isOwner) return json(404, { error: 'not_found' })

  let identity: Identity
  try { identity = isAdmin ? await authenticateAdmin(request, env) : await authenticateIdentity(request, env) }
  catch (error) {
    const status = authStatus(error, 401)
    return json(status, { error: status === 503 ? (isAdmin ? 'admin_auth_not_configured' : 'owner_auth_not_configured') : status === 403 ? 'forbidden' : 'unauthorized' })
  }

  const url = new URL(request.url)
  const parts = path.split('/').filter(Boolean)
  if (isOwner && path === '/owner/communications/tenants' && request.method === 'GET') {
    try { return json(200, { tenants: await listOwnerTenants(env, identity) }) }
    catch { return json(500, { error: 'owner_tenants_list_failed' }) }
  }

  let owner: Record<string, unknown> | null = null
  if (isOwner) {
    const requestedTenantId = url.searchParams.get('tenant_id')
    if (requestedTenantId && !UUID.test(requestedTenantId)) return json(400, { error: 'invalid_tenant_id' })
    try {
      const identified = await identifyOwner(env, identity, requestedTenantId)
      if (identified.conflict) return json(409, { error: 'tenant_selection_required' })
      owner = identified.owner
    } catch { return json(500, { error: 'owner_lookup_failed' }) }
    if (!owner) return json(403, { error: 'active_owner_required' })
  }

  const conversationId = parts[2] && parts[2] !== 'owners' ? parts[2] : null

  if (isAdmin && path === '/admin/communications/owners' && request.method === 'GET') {
    try {
      const result = await env.DB.prepare(
        `SELECT pu.id AS user_id,pu.email,json_group_array(DISTINCT t.name) AS tenant_names
         FROM platform_users pu
         JOIN tenant_memberships tm ON tm.user_id=pu.id
         JOIN tenants t ON t.id=tm.tenant_id
         WHERE tm.role='owner' AND tm.status='active' AND t.status='active'
         GROUP BY pu.id,pu.email ORDER BY pu.email,pu.id`,
      ).all<Record<string, unknown>>()
      return json(200, { owners: result.results.map(row => ({
        ...row,
        tenant_names: typeof row.tenant_names === 'string' ? JSON.parse(row.tenant_names) as string[] : [],
      })) })
    } catch { return json(500, { error: 'owner_list_failed' }) }
  }

  if (request.method === 'GET' && !conversationId) {
    try {
      const result = isAdmin
        ? await env.DB.prepare(
          `SELECT c.id,c.kind,c.subject,c.status,c.created_at,c.updated_at,
             (SELECT body FROM communication_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_message,
             (SELECT count(*) FROM communication_participants p WHERE p.conversation_id=c.id) AS participant_count,
             (SELECT count(*) FROM communication_messages m
               WHERE m.conversation_id=c.id AND m.sender_role='owner'
                 AND m.created_at>COALESCE((SELECT max(am.created_at) FROM communication_messages am WHERE am.conversation_id=c.id AND am.sender_role='admin'),c.created_at)) AS unread_count
           FROM communication_conversations c ORDER BY c.updated_at DESC LIMIT 200`,
        ).all()
        : await env.DB.prepare(
          `SELECT c.id,c.kind,c.subject,c.status,c.created_at,c.updated_at,
             (SELECT body FROM communication_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_message,
             (SELECT count(*) FROM communication_messages m
               WHERE m.conversation_id=c.id AND m.sender_role='admin'
                 AND (p.last_read_at IS NULL OR m.created_at>p.last_read_at)) AS unread_count
           FROM communication_conversations c
           JOIN communication_participants p ON p.conversation_id=c.id
           WHERE p.user_id=? AND (p.tenant_id=? OR (p.tenant_id IS NULL AND c.kind IN ('group','announcement')))
           ORDER BY c.updated_at DESC LIMIT 100`,
        ).bind(owner!.user_id, owner!.tenant_id).all()
      return json(200, { conversations: result.results })
    } catch { return json(500, { error: 'conversations_list_failed' }) }
  }

  if (isOwner && request.method === 'POST' && !conversationId) {
    let body: Record<string, unknown>
    try { body = await readBody(request) } catch (error) { return bodyError(error) }
    const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!subject || subject.length > 180 || !message || message.length > 5000) return json(400, { error: 'invalid_conversation' })
    const id = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    try {
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO communication_conversations(id,kind,subject,created_by_role,created_by_subject) VALUES(? ,\'support\',?,\'owner\',?)',
        ).bind(id, subject, identity.subject),
        env.DB.prepare(
          'INSERT INTO communication_participants(conversation_id,user_id,tenant_id) VALUES(?,?,?)',
        ).bind(id, owner!.user_id, owner!.tenant_id),
        env.DB.prepare(
          'INSERT INTO communication_messages(id,conversation_id,sender_role,sender_subject,sender_user_id,body) VALUES(?, ?, \'owner\', ?, ?, ?)',
        ).bind(messageId, id, identity.subject, owner!.user_id, message),
      ])
      return json(201, { message: { id: messageId, conversation_id: id, body: message } })
    } catch { return json(500, { error: 'conversation_create_failed' }) }
  }

  if (conversationId && request.method === 'GET') {
    if (!UUID.test(conversationId)) return json(400, { error: 'invalid_conversation_id' })
    try {
      const access = isAdmin
        ? await env.DB.prepare('SELECT id FROM communication_conversations WHERE id=?').bind(conversationId).first()
        : await env.DB.prepare(
          `SELECT c.id FROM communication_conversations c
           JOIN communication_participants p ON p.conversation_id=c.id
           WHERE c.id=? AND p.user_id=?
             AND (p.tenant_id=? OR (p.tenant_id IS NULL AND c.kind IN ('group','announcement')))`,
        ).bind(conversationId, owner!.user_id, owner!.tenant_id).first()
      if (!access) return json(404, { error: 'conversation_not_found' })
      const result = await env.DB.prepare(
        'SELECT id,sender_role,sender_subject,body,created_at FROM communication_messages WHERE conversation_id=? ORDER BY created_at,id LIMIT 500',
      ).bind(conversationId).all()
      if (isOwner) {
        await env.DB.prepare(
          "UPDATE communication_participants SET last_read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id=? AND user_id=? AND (tenant_id=? OR tenant_id IS NULL)",
        ).bind(conversationId, owner!.user_id, owner!.tenant_id).run()
      }
      return json(200, { messages: result.results })
    } catch { return json(500, { error: 'messages_list_failed' }) }
  }

  if (conversationId && request.method === 'POST' && parts[3] === 'messages') {
    if (!UUID.test(conversationId)) return json(400, { error: 'invalid_conversation_id' })
    let body: Record<string, unknown>
    try { body = await readBody(request) } catch (error) { return bodyError(error) }
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message || message.length > 5000) return json(400, { error: 'invalid_message' })
    try {
      const access = isAdmin
        ? await env.DB.prepare('SELECT id FROM communication_conversations WHERE id=?').bind(conversationId).first()
        : await env.DB.prepare(
          `SELECT c.id FROM communication_conversations c
           JOIN communication_participants p ON p.conversation_id=c.id
           WHERE c.id=? AND p.user_id=?
             AND (p.tenant_id=? OR (p.tenant_id IS NULL AND c.kind IN ('group','announcement')))`,
        ).bind(conversationId, owner!.user_id, owner!.tenant_id).first()
      if (!access) return json(404, { error: 'conversation_not_found' })
      const messageId = crypto.randomUUID()
      const senderRole = isAdmin ? 'admin' : 'owner'
      const senderUserId = isAdmin ? null : owner!.user_id
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO communication_messages(id,conversation_id,sender_role,sender_subject,sender_user_id,body) VALUES(?,?,?,?,?,?)',
        ).bind(messageId, conversationId, senderRole, identity.subject, senderUserId, message),
        env.DB.prepare(
          `UPDATE communication_conversations SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            status=CASE WHEN ?='admin' AND status='resolved' THEN 'in_progress' ELSE status END
           WHERE id=?`,
        ).bind(senderRole, conversationId),
      ])
      return json(201, { message: { id: messageId, conversation_id: conversationId, sender_role: senderRole, sender_subject: identity.subject, body: message } })
    } catch { return json(500, { error: 'message_send_failed' }) }
  }

  if (isAdmin && conversationId && request.method === 'PATCH') {
    if (!UUID.test(conversationId)) return json(400, { error: 'invalid_conversation_id' })
    let body: Record<string, unknown>
    try { body = await readBody(request) } catch (error) { return bodyError(error) }
    if (typeof body.status !== 'string' || !STATUSES.includes(body.status)) return json(400, { error: 'invalid_status' })
    try {
      const result = await env.DB.prepare(
        `UPDATE communication_conversations SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=? RETURNING id,status`,
      ).bind(body.status, conversationId).all()
      return result.results.length ? json(200, { conversation: result.results[0] }) : json(404, { error: 'conversation_not_found' })
    } catch { return json(500, { error: 'conversation_update_failed' }) }
  }

  if (isAdmin && request.method === 'POST' && !conversationId) {
    let body: Record<string, unknown>
    try { body = await readBody(request) } catch (error) { return bodyError(error) }
    const kind = body.kind
    const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    const userIds = Array.isArray(body.user_ids)
      ? [...new Set(body.user_ids.filter((id): id is string => typeof id === 'string' && UUID.test(id)))]
      : []
    if (!['group','announcement'].includes(String(kind)) || !subject || subject.length > 180 || !message || message.length > 5000 || userIds.length < 1 || userIds.length > 90) {
      return json(400, { error: 'invalid_group_or_announcement' })
    }
    const placeholders = userIds.map(() => '?').join(',')
    try {
      const selected = await env.DB.prepare(
        `SELECT DISTINCT pu.id FROM platform_users pu
         JOIN tenant_memberships tm ON tm.user_id=pu.id
         WHERE pu.id IN (${placeholders}) AND tm.role='owner' AND tm.status='active'`,
      ).bind(...userIds).all<{ id: string }>()
      if (!selected.results.length) return json(400, { error: 'no_active_owners_selected' })
      const id = crypto.randomUUID()
      const messageId = crypto.randomUUID()
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO communication_conversations(id,kind,subject,created_by_role,created_by_subject)
           SELECT ?,?,?, 'admin', ? WHERE EXISTS (
             SELECT 1 FROM platform_users pu JOIN tenant_memberships tm ON tm.user_id=pu.id
             WHERE pu.id IN (${placeholders}) AND tm.role='owner' AND tm.status='active'
           )`,
        ).bind(id, kind, subject, identity.subject, ...userIds),
        env.DB.prepare(
          `INSERT INTO communication_participants(conversation_id,user_id,tenant_id)
           SELECT DISTINCT ?,pu.id,NULL FROM platform_users pu JOIN tenant_memberships tm ON tm.user_id=pu.id
           WHERE pu.id IN (${placeholders}) AND tm.role='owner' AND tm.status='active'`,
        ).bind(id, ...userIds),
        env.DB.prepare(
          `INSERT INTO communication_messages(id,conversation_id,sender_role,sender_subject,body)
           SELECT ?,?,'admin',?,? WHERE EXISTS (SELECT 1 FROM communication_participants WHERE conversation_id=?)`,
        ).bind(messageId, id, identity.subject, message, id),
      ])
      const participants = await env.DB.prepare('SELECT count(*) AS count FROM communication_participants WHERE conversation_id=?').bind(id).first<{ count: number }>()
      if (!participants?.count) {
        await env.DB.prepare('DELETE FROM communication_conversations WHERE id=?').bind(id).run()
        return json(400, { error: 'no_active_owners_selected' })
      }
      return json(201, { conversation: { id, message_id: messageId, recipient_count: participants.count } })
    } catch { return json(500, { error: 'group_create_failed' }) }
  }

  return json(405, { error: 'method_not_allowed' })
}
