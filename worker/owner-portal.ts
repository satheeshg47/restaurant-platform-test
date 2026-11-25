import { authenticateIdentity, authStatus } from './auth.ts'
import type { Env, Identity } from './types.ts'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export async function handleOwnerRestaurants(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' })

  let identity: Identity
  try {
    identity = await authenticateIdentity(request, env)
  } catch (error) {
    const status = authStatus(error, 401)
    return json(status, {
      error: status === 503 ? 'owner_auth_not_configured' : status === 403 ? 'forbidden' : 'unauthorized',
    })
  }

  try {
    const result = await env.DB.prepare(
      `SELECT t.id AS tenant_id,t.name AS tenant_name,t.slug AS tenant_slug,t.status AS tenant_status,
         tm.role,tm.created_at AS membership_created_at,
         rp.display_name,rp.city,rp.state_name,rp.currency_code,rp.timezone,rp.accepting_orders
       FROM platform_users pu
       JOIN tenant_memberships tm ON tm.user_id=pu.id
       JOIN tenants t ON t.id=tm.tenant_id
       JOIN tenant_applications ta ON ta.tenant_id=t.id AND ta.status='active'
       JOIN applications a ON a.id=ta.application_id AND a.app_key='restaurant' AND a.status='active'
       LEFT JOIN restaurant_profiles rp ON rp.tenant_id=t.id
       WHERE pu.auth_provider=? AND pu.auth_subject=?
         AND tm.status='active' AND tm.role IN ('owner','admin')
         AND t.status='active'
       ORDER BY tm.created_at,t.name,t.id`,
    ).bind(identity.issuer, identity.subject).all<Record<string, unknown>>()
    const restaurants = result.results.map(row => ({
      ...row,
      accepting_orders: row.accepting_orders === null ? null : Boolean(row.accepting_orders),
    }))
    // The demo tenant is listed only for the same authenticated identity that
    // was explicitly provisioned by the Super Admin in the isolated demo DB.
    if (env.DEMO_DB) {
      const demo = await env.DEMO_DB.prepare(
        `SELECT t.id AS tenant_id,t.name AS tenant_name,t.slug AS tenant_slug,t.status AS tenant_status,
           tm.role,tm.created_at AS membership_created_at,
           rp.display_name,rp.city,rp.state_name,rp.currency_code,rp.timezone,rp.accepting_orders
         FROM platform_users pu
         JOIN tenant_memberships tm ON tm.user_id=pu.id
         JOIN tenants t ON t.id=tm.tenant_id
         JOIN tenant_applications ta ON ta.tenant_id=t.id AND ta.status='active'
         JOIN applications a ON a.id=ta.application_id AND a.app_key='restaurant' AND a.status='active'
         LEFT JOIN restaurant_profiles rp ON rp.tenant_id=t.id
         WHERE pu.auth_provider=? AND pu.auth_subject=? AND t.slug='platform-demo-restaurant'
           AND tm.status='active' AND tm.role IN ('owner','admin') AND t.status='active'
         LIMIT 1`,
      ).bind(identity.issuer, identity.subject).first<Record<string, unknown>>()
      if (demo) restaurants.unshift({
        ...demo,
        accepting_orders: demo.accepting_orders === null ? null : Boolean(demo.accepting_orders),
      })
    }
    return json(200, { restaurants })
  } catch {
    return json(500, { error: 'owner_restaurants_list_failed' })
  }
}
