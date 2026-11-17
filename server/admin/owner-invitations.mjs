import { createHash, randomBytes } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_BODY_BYTES = 8192

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
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body')
    return body
  } catch {
    const error = new Error('invalid json')
    error.statusCode = 400
    throw error
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

export async function handleOwnerInvitations(request, response, {
  database = null, authenticateAdmin = null, authenticateIdentity = null,
} = {}) {
  const path = new URL(request.url, 'http://localhost').pathname
  const isAdmin = path === '/admin/owner-invitations'
  const revokePrefix = '/admin/owner-invitations/'
  const revokeMatch = path.startsWith(revokePrefix) && path.endsWith('/revoke')
    ? path.slice(revokePrefix.length, -'/revoke'.length)
    : null
  const isAdminRoute = isAdmin || Boolean(revokeMatch)
  const isAccept = path === '/owner/invitations/accept'
  if (!isAdminRoute && !isAccept) return false

  const authenticate = isAdminRoute ? authenticateAdmin : authenticateIdentity
  if (!authenticate) {
    send(response, 503, { error: isAdmin ? 'admin_auth_not_configured' : 'owner_auth_not_configured' })
    return true
  }
  let identity
  try { identity = await authenticate(request) }
  catch (error) {
    send(response, error.statusCode === 403 ? 403 : 401, { error: error.statusCode === 403 ? 'forbidden' : 'unauthorized' })
    return true
  }
  if (!database) {
    send(response, 503, { error: 'database_not_configured' })
    return true
  }

  if (isAdminRoute && isAdmin && request.method === 'GET') {
    try {
      const result = await database.query(`
        SELECT i.id,i.tenant_id,t.name AS tenant_name,t.slug AS tenant_slug,
          i.email,i.status,i.created_at,i.expires_at
        FROM platform_owner_invitations i
        JOIN tenants t ON t.id=i.tenant_id
        ORDER BY i.created_at DESC
        LIMIT 500
      `)
      send(response,200,{invitations:result.rows})
    } catch {
      send(response,500,{error:'owner_invitation_list_failed'})
    }
    return true
  }

  if (isAdminRoute && revokeMatch !== null) {
    if (request.method !== 'POST') {
      response.setHeader('Allow','POST')
      send(response,405,{error:'method_not_allowed'})
      return true
    }
    const invitationId = revokeMatch
    if (!UUID.test(invitationId)) {
      send(response,400,{error:'invalid_invitation_id'})
      return true
    }
    if (typeof database.connect !== 'function') {
      send(response,503,{error:'transaction_support_required'})
      return true
    }
    let client
    try {
      client = await database.connect()
      await client.query('BEGIN')
      const found = await client.query(
        'SELECT id,status,tenant_id,email FROM platform_owner_invitations WHERE id=$1 FOR UPDATE',
        [invitationId],
      )
      const invitation = found.rows[0]
      if (!invitation) {
        await client.query('ROLLBACK')
        send(response,404,{error:'invitation_not_found'})
        return true
      }
      if (invitation.status !== 'pending') {
        await client.query('ROLLBACK')
        send(response,409,{error:'invitation_not_pending'})
        return true
      }
      const updated = await client.query(
        "UPDATE platform_owner_invitations SET status='revoked' WHERE id=$1 AND status='pending' RETURNING id",
        [invitationId],
      )
      if (!updated.rows.length) {
        await client.query('ROLLBACK')
        send(response,409,{error:'invitation_not_pending'})
        return true
      }
      await client.query(
        `INSERT INTO platform_audit_events
          (actor_issuer,actor_subject,action,resource_type,resource_id,metadata)
         VALUES($1,$2,'owner.invitation.revoked','owner_invitation',$3,
           jsonb_build_object('tenant_id',$4::text,'email',$5))`,
        [identity.issuer,identity.subject,invitation.id,invitation.tenant_id,invitation.email],
      )
      await client.query('COMMIT')
      send(response,200,{revoked:true,id:invitation.id})
    } catch {
      try { await client?.query('ROLLBACK') } catch {}
      send(response,500,{error:'owner_invitation_revoke_failed'})
    } finally {
      client?.release()
    }
    return true
  }

  if (isAdminRoute && isAdmin) {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      send(response, 405, { error: 'method_not_allowed' })
      return true
    }
    let body
    try { body = await readBody(request) }
    catch (error) {
      send(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'payload_too_large' : 'invalid_json' })
      return true
    }
    const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id : ''
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!UUID.test(tenantId) || email.length > 320 || !EMAIL.test(email) ||
        typeof identity?.issuer !== 'string' || typeof identity?.subject !== 'string') {
      send(response, 400, { error: 'invalid_invitation' })
      return true
    }

    if (typeof database.connect !== 'function') {
      send(response,503,{error:'transaction_support_required'})
      return true
    }
    const token = randomBytes(32).toString('base64url')
    const hash = tokenHash(token)
    let client
    try {
      client = await database.connect()
      await client.query('BEGIN')
      const tenant = await client.query(
        "SELECT id FROM tenants WHERE id=$1 AND status='active' FOR UPDATE",
        [tenantId],
      )
      if (!tenant.rows.length) {
        await client.query('ROLLBACK')
        send(response,404,{error:'tenant_not_found'})
        return true
      }
      await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId])
      const owner = await client.query(
        "SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND role='owner' AND status='active' LIMIT 1",
        [tenantId],
      )
      if (owner.rows.length) {
        await client.query('ROLLBACK')
        send(response,409,{error:'active_owner_already_exists'})
        return true
      }
      await client.query(
        "UPDATE platform_owner_invitations SET status='expired' WHERE tenant_id=$1 AND email=$2 AND status='pending' AND expires_at<=now()",
        [tenantId,email],
      )
      const inserted = await client.query(
        `INSERT INTO platform_owner_invitations
          (tenant_id,email,token_hash,created_by_issuer,created_by_subject,expires_at)
         VALUES($1,$2,$3,$4,$5,now()+interval '48 hours')
         ON CONFLICT (tenant_id,email) WHERE status='pending' DO NOTHING
         RETURNING id,tenant_id,email,expires_at`,
        [tenantId,email,hash,identity.issuer,identity.subject],
      )
      if (!inserted.rows.length) {
        await client.query('ROLLBACK')
        send(response,409,{error:'pending_invitation_exists'})
        return true
      }
      const row = inserted.rows[0]
      await client.query(
        `INSERT INTO platform_audit_events
          (actor_issuer,actor_subject,action,resource_type,resource_id,metadata)
         VALUES($1,$2,'owner.invitation.created','owner_invitation',$3,
           jsonb_build_object('tenant_id',$4::text,'email',$5))`,
        [identity.issuer,identity.subject,row.id,tenantId,email],
      )
      await client.query('COMMIT')
      send(response,201,{
        invitation:{id:row.id,tenant_id:row.tenant_id,email:row.email,expires_at:row.expires_at},
        token,
        delivery:'manual_link_required',
      })
    } catch {
      try { await client?.query('ROLLBACK') } catch {}
      send(response,500,{error:'owner_invitation_create_failed'})
    } finally {
      client?.release()
    }
    return true
  }

  if (request.method !== 'POST') {
    response.setHeader('Allow','POST')
    send(response,405,{error:'method_not_allowed'})
    return true
  }
  if (identity?.emailVerified !== true || typeof identity.email !== 'string' ||
      !identity.email.trim() || typeof identity.issuer !== 'string' || typeof identity.subject !== 'string') {
    send(response,403,{error:'verified_email_required'})
    return true
  }
  let body
  try { body = await readBody(request) }
  catch (error) {
    send(response,error.statusCode||400,{error:error.statusCode===413?'payload_too_large':'invalid_json'})
    return true
  }
  const token = typeof body.token === 'string' ? body.token : ''
  if (!TOKEN.test(token)) {
    send(response,400,{error:'invalid_invitation_token'})
    return true
  }

  let client
  try {
    if (typeof database.connect !== 'function') {
      send(response,503,{error:'transaction_support_required'})
      return true
    }
    client = await database.connect()
    await client.query('BEGIN')
    const found = await client.query(
      `SELECT i.id,i.tenant_id,i.email,i.status,i.expires_at,t.name AS tenant_name,t.status AS tenant_status
       FROM platform_owner_invitations i
       JOIN tenants t ON t.id=i.tenant_id
       WHERE i.token_hash=$1
       FOR UPDATE OF i,t`,
      [tokenHash(token)],
    )
    const invitation = found.rows[0]
    if (!invitation || invitation.status !== 'pending') {
      await client.query('ROLLBACK')
      send(response,404,{error:'invitation_not_found'})
      return true
    }
    if (invitation.tenant_status !== 'active') {
      await client.query('ROLLBACK')
      send(response,409,{error:'tenant_not_active'})
      return true
    }
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[invitation.tenant_id])
    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      await client.query("UPDATE platform_owner_invitations SET status='expired' WHERE id=$1",[invitation.id])
      await client.query('COMMIT')
      send(response,410,{error:'invitation_expired'})
      return true
    }
    if (invitation.email !== identity.email.trim().toLowerCase()) {
      await client.query('ROLLBACK')
      send(response,403,{error:'invitation_email_mismatch'})
      return true
    }
    const activeOwner = await client.query(
      "SELECT user_id FROM tenant_memberships WHERE tenant_id=$1 AND role='owner' AND status='active' FOR UPDATE",
      [invitation.tenant_id],
    )
    if (activeOwner.rows.length) {
      await client.query('ROLLBACK')
      send(response,409,{error:'active_owner_already_exists'})
      return true
    }
    const user = await client.query(
      `INSERT INTO platform_users(auth_provider,auth_subject,email)
       VALUES($1,$2,$3)
       ON CONFLICT(auth_provider,auth_subject) DO UPDATE SET email=EXCLUDED.email
       RETURNING id`,
      [identity.issuer,identity.subject,identity.email.trim().toLowerCase()],
    )
    await client.query(
      `INSERT INTO tenant_memberships(tenant_id,user_id,role,status)
       VALUES($1,$2,'owner','active')
       ON CONFLICT(tenant_id,user_id) DO UPDATE SET role='owner',status='active'`,
      [invitation.tenant_id,user.rows[0].id],
    )
    await client.query(
      `UPDATE platform_owner_invitations
       SET status='accepted',accepted_by_issuer=$2,accepted_by_subject=$3,accepted_at=now()
       WHERE id=$1`,
      [invitation.id,identity.issuer,identity.subject],
    )
    await client.query(
      `INSERT INTO platform_audit_events
       (actor_issuer,actor_subject,action,resource_type,resource_id,metadata)
       VALUES($1,$2,'owner.invitation.accepted','tenant',$3,
         jsonb_build_object('invitation_id',$4::text,'user_id',$5::text))`,
      [identity.issuer,identity.subject,invitation.tenant_id,invitation.id,user.rows[0].id],
    )
    await client.query('COMMIT')
    send(response,200,{accepted:true,tenant:{id:invitation.tenant_id,name:invitation.tenant_name}})
  } catch {
    try { await client?.query('ROLLBACK') } catch {}
    send(response,500,{error:'owner_invitation_accept_failed'})
  } finally {
    client?.release()
  }
  return true
}
