import { authenticateAdmin, authStatus } from './auth.ts'
import type { Env, Identity } from './types.ts'

const DEMO_SLUG = 'platform-demo-restaurant'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export async function handleDemoProvision(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  let admin: Identity
  try { admin = await authenticateAdmin(request, env) }
  catch (error) {
    const status = authStatus(error, 401)
    return json(status, { error: status === 503 ? 'admin_auth_not_configured' : status === 403 ? 'forbidden' : 'unauthorized' })
  }
  if (!env.DEMO_DB) return json(503, { error: 'demo_storage_not_configured' })

  const db = env.DEMO_DB
  try {
    const existing = await db.prepare("SELECT id FROM tenants WHERE slug=? AND status='active' LIMIT 1")
      .bind(DEMO_SLUG).first<{ id: string }>()
    const application = await db.prepare("SELECT id FROM applications WHERE app_key='restaurant' AND status='active' LIMIT 1")
      .first<{ id: string }>()
    if (!application) return json(503, { error: 'restaurant_application_not_configured_in_demo_db' })

    const tenantId = existing?.id || crypto.randomUUID()
    const userId = (await db.prepare('SELECT id FROM platform_users WHERE auth_provider=? AND auth_subject=?')
      .bind(admin.issuer, admin.subject).first<{ id: string }>())?.id || crypto.randomUUID()
    const staffId = (await db.prepare('SELECT id FROM restaurant_staff WHERE tenant_id=? AND username=?')
      .bind(tenantId, 'demo-owner').first<{ id: string }>())?.id || crypto.randomUUID()

    const statements = [
      db.prepare("INSERT OR IGNORE INTO tenants(id,name,slug,status) VALUES(?,? ,?,'active')")
        .bind(tenantId, 'Demo Restaurant', DEMO_SLUG),
      db.prepare('INSERT OR IGNORE INTO platform_users(id,auth_provider,auth_subject,email) VALUES(?,?,?,?)')
        .bind(userId, admin.issuer, admin.subject, admin.email || null),
      db.prepare("INSERT OR IGNORE INTO tenant_applications(tenant_id,application_id,status) VALUES(?,?,'active')")
        .bind(tenantId, application.id),
      db.prepare("INSERT OR IGNORE INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(?,?,'owner','active')")
        .bind(tenantId, userId),
      db.prepare(`INSERT OR IGNORE INTO restaurant_profiles
        (tenant_id,display_name,currency_code,timezone,default_language,tax_mode,tax_rate,gst_rate,tax_inclusive,accepting_orders,city,state_name,state_code,invoice_prefix)
        VALUES(?,'Platform Demo Restaurant','INR','Asia/Kolkata','en','gst',5,5,0,1,'Bengaluru','Karnataka','29','DM')`)
        .bind(tenantId),
      db.prepare("INSERT OR IGNORE INTO restaurant_staff(id,tenant_id,user_id,username,display_name,role,active) VALUES(?,?,?,'demo-owner','Demo Owner','owner',1)")
        .bind(staffId, tenantId, userId),
      db.prepare("INSERT OR IGNORE INTO restaurant_tenant_controls(tenant_id) VALUES(?)").bind(tenantId),
      db.prepare("INSERT OR IGNORE INTO restaurant_menu_categories(id,tenant_id,name,sort_order,station) VALUES(?,?,?,1,'kitchen')")
        .bind(crypto.randomUUID(), tenantId, JSON.stringify({ en: 'South Indian', kn: 'ದಕ್ಷಿಣ ಭಾರತೀಯ' })),
      db.prepare("INSERT OR IGNORE INTO restaurant_menu_categories(id,tenant_id,name,sort_order,station) VALUES(?,?,?,2,'kitchen')")
        .bind(crypto.randomUUID(), tenantId, JSON.stringify({ en: 'North Indian', kn: 'ಉತ್ತರ ಭಾರತೀಯ' })),
      db.prepare("INSERT OR IGNORE INTO restaurant_menu_categories(id,tenant_id,name,sort_order,station) VALUES(?,?,?,3,'beverage')")
        .bind(crypto.randomUUID(), tenantId, JSON.stringify({ en: 'Beverages', kn: 'ಪಾನೀಯಗಳು' })),
    ]
    await db.batch(statements)

    const categories = await db.prepare('SELECT id,name FROM restaurant_menu_categories WHERE tenant_id=? ORDER BY sort_order')
      .bind(tenantId).all<{ id: string; name: string }>()
    const south = categories.results.find(row => row.name.includes('South Indian'))?.id
    const north = categories.results.find(row => row.name.includes('North Indian'))?.id
    const drinks = categories.results.find(row => row.name.includes('Beverages'))?.id
    if (!south || !north || !drinks) throw new Error('demo_categories_unavailable')

    const menu = [
      ['Masala Dosa', south, 8500, 'veg', 12], ['Idli Vada', south, 6500, 'veg', 8],
      ['Bisi Bele Bath', south, 9500, 'veg', 15], ['Paneer Butter Masala', north, 18500, 'veg', 18],
      ['Butter Naan', north, 4500, 'veg', 5], ['Chicken Biryani', north, 19500, 'non_veg', 22],
      ['Filter Coffee', drinks, 3500, 'veg', 4], ['Fresh Lime Soda', drinks, 5500, 'veg', 3],
      ['Mango Lassi', drinks, 6500, 'veg', 4],
    ] as const
    for (let i = 0; i < menu.length; i++) {
      const [name, categoryId, price, foodType, prep] = menu[i]
      await db.prepare(`INSERT INTO restaurant_menu_items
        (tenant_id,category_id,name,description,base_price_minor,food_type,prep_minutes,sort_order,active,available)
        SELECT ?,?,?,?, ?,?,?,?,1,1
        WHERE NOT EXISTS (SELECT 1 FROM restaurant_menu_items WHERE tenant_id=? AND json_extract(name,'$.en')=?)`)
        .bind(tenantId, categoryId, JSON.stringify({ en: name }), JSON.stringify({ en: 'Freshly prepared demo menu item' }),
          price, foodType, prep, i + 1, tenantId, name).run()
    }

    const tableTokens: Array<{ label: string; url: string }> = []
    for (let n = 1; n <= 10; n++) {
      const qr = token()
      const hash = await sha256(qr)
      const label = 'Table ' + n
      await db.prepare(`INSERT INTO restaurant_tables(tenant_id,table_number,label,table_type,public_token_hash)
        SELECT ?,?,?, 'dine_in', ? WHERE NOT EXISTS (SELECT 1 FROM restaurant_tables WHERE tenant_id=? AND table_number=?)`)
        .bind(tenantId, n, label, hash, tenantId, n).run()
      // A token is returned only when it was just created. Existing table QR
      // hashes are intentionally never overwritten on repeated provisioning.
      const row = await db.prepare('SELECT id,public_token_hash FROM restaurant_tables WHERE tenant_id=? AND table_number=?')
        .bind(tenantId, n).first<{ id: string; public_token_hash: string | null }>()
      if (row?.public_token_hash === hash) tableTokens.push({ label, url: '/r/' + DEMO_SLUG + '/' + qr })
    }

    await env.DB.prepare(
      'INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata) VALUES(?,?,?,?,?,?)',
    ).bind(admin.issuer, admin.subject, 'demo.restaurant.provisioned', 'tenant', tenantId,
      JSON.stringify({ slug: DEMO_SLUG, storage: 'isolated-preview-d1' })).run()

    return json(200, {
      provisioned: true,
      tenant: { id: tenantId, name: 'Platform Demo Restaurant', slug: DEMO_SLUG },
      qr_codes: tableTokens,
      note: 'Demo data is stored only in the isolated demo database. No real payments are processed.',
    })
  } catch (error) {
    return json(500, { error: 'demo_provision_failed', detail: error instanceof Error ? error.message : 'unknown_error' })
  }
}
