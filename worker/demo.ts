import type { Env, Identity } from './types.ts'
import { hashPassword } from './native-auth-crypto.ts'

const DEMO_SLUG = 'platform-demo-restaurant'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function stableToken(seed: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)))
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function ensureDemoStaffAccount(db: Env['DB'], tenantId: string, role: 'cook' | 'waiter' | 'manager', loginId: string, displayName: string, password: string): Promise<string> {
  const userId = 'demo-user-' + role + '-' + tenantId
  const staffId = 'demo-staff-' + role + '-' + tenantId
  const passwordHash = await hashPassword(password)
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO platform_users(id,auth_provider,auth_subject,email) VALUES(?,'native',?,NULL)").bind(userId, userId),
    db.prepare(`INSERT INTO platform_user_credentials(user_id,login_id,login_id_normalized,password_hash,credential_status)
      VALUES(?,?,?,?, 'active') ON CONFLICT(user_id) DO UPDATE SET login_id=excluded.login_id,login_id_normalized=excluded.login_id_normalized,password_hash=excluded.password_hash,credential_status='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .bind(userId, loginId, loginId.toLowerCase(), passwordHash),
    db.prepare("INSERT OR IGNORE INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(?,?,'staff','active')").bind(tenantId, userId),
    db.prepare("INSERT OR IGNORE INTO restaurant_staff(id,tenant_id,user_id,username,display_name,role,active) VALUES(?,?,?,?,?,?,1)").bind(staffId, tenantId, userId, loginId.toLowerCase(), displayName, role),
  ])
  return staffId
}

async function seedHistory(db: Env['DB'], tenantId: string, ownerId: string, cookId: string, waiterId: string, menuItemId: string, categoryId: string): Promise<void> {
  const sessionSql = `
    WITH RECURSIVE days(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM days WHERE n<365),
    slots(s) AS (VALUES(1),(2),(3))
    INSERT OR IGNORE INTO restaurant_table_sessions
      (id,tenant_id,table_id,status,guest_count,opened_by,opened_at,closed_by,closed_at,close_reason)
    SELECT 'demo-session-'||days.n||'-'||slots.s, ?,
      (SELECT id FROM restaurant_tables WHERE tenant_id=? AND table_number=((days.n+slots.s-2)%10)+1),
      'closed',2,?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now',printf('-%d days',365-days.n),printf('+%d minutes',slots.s*100)),
      ?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now',printf('-%d days',365-days.n),printf('+%d minutes',slots.s*100+55)),
      'demo-history'
    FROM days CROSS JOIN slots`
  await db.prepare(sessionSql).bind(tenantId, tenantId, ownerId, ownerId).run()

  const orderSql = `
    WITH RECURSIVE days(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM days WHERE n<365),
    slots(s) AS (VALUES(1),(2),(3))
    INSERT OR IGNORE INTO restaurant_orders
      (id,tenant_id,order_number,table_id,session_id,status,subtotal_minor,tax_minor,total_minor,
       source,idempotency_key,placed_by,accepted_at,preparation_started_at,ready_at,served_at,
       tax_mode_snapshot,tax_rate_snapshot,tax_inclusive_snapshot,created_at)
    SELECT 'demo-order-'||days.n||'-'||slots.s, ?, days.n*3+slots.s,
      (SELECT table_id FROM restaurant_table_sessions WHERE id='demo-session-'||days.n||'-'||slots.s),
      'demo-session-'||days.n||'-'||slots.s,'served',10000,500,10500,
      CASE slots.s WHEN 1 THEN 'qr' WHEN 2 THEN 'waiter' ELSE 'qr' END,
      'demo-key-'||days.n||'-'||slots.s, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now',printf('-%d days',365-days.n),printf('+%d minutes',slots.s*100+2)),
      strftime('%Y-%m-%dT%H:%M:%fZ','now',printf('-%d days',365-days.n),printf('+%d minutes',slots.s*100+5)),
      strftime('%Y-%m-%dT%H:%M:%fZ','now',printf('-%d days',365-days.n),printf('+%d minutes',slots.s*100+25)),
      strftime('%Y-%m-%dT%H:%M:%fZ','now',printf('-%d days',365-days.n),printf('+%d minutes',slots.s*100+50)),
      'gst',5,0,
      strftime('%Y-%m-%dT%H:%M:%fZ','now',printf('-%d days',365-days.n),printf('+%d minutes',slots.s*100))
    FROM days CROSS JOIN slots`
  await db.prepare(orderSql).bind(tenantId, ownerId).run()

  const itemSql = `
    INSERT OR IGNORE INTO restaurant_order_items
      (id,tenant_id,order_id,item_id,category_id,item_name_snapshot,quantity,unit_price_minor,
       addons_price_minor,line_total_minor,status,accepted_by,created_at,preparation_started_at,ready_at,served_at)
    SELECT 'demo-line-'||o.order_number, o.tenant_id,o.id,
      (SELECT mi.id FROM restaurant_menu_items mi WHERE mi.tenant_id=o.tenant_id AND json_extract(mi.name,'$.en')=
        CASE (o.order_number%5) WHEN 0 THEN 'Masala Dosa' WHEN 1 THEN 'Idli Vada' WHEN 2 THEN 'Bisi Bele Bath'
          WHEN 3 THEN 'Paneer Butter Masala' ELSE 'Chicken Biryani' END LIMIT 1),
      (SELECT mi.category_id FROM restaurant_menu_items mi WHERE mi.tenant_id=o.tenant_id AND json_extract(mi.name,'$.en')=
        CASE (o.order_number%5) WHEN 0 THEN 'Masala Dosa' WHEN 1 THEN 'Idli Vada' WHEN 2 THEN 'Bisi Bele Bath'
          WHEN 3 THEN 'Paneer Butter Masala' ELSE 'Chicken Biryani' END LIMIT 1),
      CASE (o.order_number%5)
        WHEN 0 THEN '{"en":"Masala Dosa","kn":"ಮಸಾಲೆ ದೋಸೆ"}'
        WHEN 1 THEN '{"en":"Idli Vada","kn":"ಇಡ್ಲಿ ವಡೆ"}'
        WHEN 2 THEN '{"en":"Bisi Bele Bath","kn":"ಬಿಸಿ ಬೇಳೆ ಬಾತ್"}'
        WHEN 3 THEN '{"en":"Paneer Butter Masala","kn":"ಪನೀರ್ ಬಟರ್ ಮಸಾಲಾ"}'
        ELSE '{"en":"Chicken Biryani","kn":"ಚಿಕನ್ ಬಿರಿಯಾನಿ"}' END,
      1,10000,0,10000,'served',?,
      o.created_at,o.preparation_started_at,o.ready_at,o.served_at
    FROM restaurant_orders o
    WHERE o.tenant_id=? AND o.id LIKE 'demo-order-%'`
  await db.prepare(itemSql).bind(cookId, tenantId).run()

  const paymentSql = `
    INSERT INTO restaurant_payments(tenant_id,session_id,table_id,amount_minor,method,reference,confirmed_by,paid_at)
    SELECT o.tenant_id,o.session_id,o.table_id,o.total_minor,
      CASE (o.order_number%3) WHEN 0 THEN 'cash' WHEN 1 THEN 'upi' ELSE 'card' END,
      'DEMO-PAY-'||o.order_number,?,o.served_at
    FROM restaurant_orders o
    WHERE o.tenant_id=? AND o.id LIKE 'demo-order-%'
      AND NOT EXISTS (SELECT 1 FROM restaurant_payments p WHERE p.tenant_id=o.tenant_id AND p.session_id=o.session_id)`
  await db.prepare(paymentSql).bind(ownerId, tenantId).run()

  const reviewSql = `
    INSERT OR IGNORE INTO restaurant_reviews
      (id,tenant_id,session_id,table_id,rating,comment,created_at,visibility,owner_response,responded_at,responded_by)
    SELECT 'demo-review-'||o.order_number,o.tenant_id,o.session_id,o.table_id,
      CASE (o.order_number%5) WHEN 0 THEN 3 WHEN 1 THEN 4 ELSE 5 END,
      CASE (o.order_number%4)
        WHEN 0 THEN 'Great food and quick service.'
        WHEN 1 THEN 'Loved the dosa and filter coffee.'
        WHEN 2 THEN 'Good portions and friendly staff.'
        ELSE 'Fresh food. Will visit again.' END,
      o.served_at,'published','Thank you for visiting us. We appreciate your feedback.',
      o.served_at,?
    FROM restaurant_orders o
    WHERE o.tenant_id=? AND o.id LIKE 'demo-order-%' AND o.order_number%21=0`
  await db.prepare(reviewSql).bind(ownerId, tenantId).run()

  const requestSql = `
    INSERT OR IGNORE INTO restaurant_service_requests
      (id,tenant_id,session_id,table_id,request_type,note,status,created_at,handled_by,handled_at)
    SELECT 'demo-request-'||o.order_number,o.tenant_id,o.session_id,o.table_id,
      CASE (o.order_number%3) WHEN 0 THEN 'call_waiter' WHEN 1 THEN 'request_bill' ELSE 'need_water' END,
      'Sample service request for demo','handled',o.created_at,?,o.served_at
    FROM restaurant_orders o
    WHERE o.tenant_id=? AND o.id LIKE 'demo-order-%' AND o.order_number%17=0`
  await db.prepare(requestSql).bind(waiterId, tenantId).run()

  const refundSql = `
    INSERT OR IGNORE INTO restaurant_refunds
      (id,tenant_id,order_id,order_item_id,session_id,amount_minor,reason,was_paid,created_by,created_at)
    SELECT 'demo-refund-'||o.order_number,o.tenant_id,o.id,
      (SELECT i.id FROM restaurant_order_items i WHERE i.tenant_id=o.tenant_id AND i.order_id=o.id LIMIT 1),
      o.session_id,500,'Sample partial refund',1,?,
      strftime('%Y-%m-%dT%H:%M:%fZ',o.served_at,'+10 minutes')
    FROM restaurant_orders o
    WHERE o.tenant_id=? AND o.id LIKE 'demo-order-%' AND o.order_number%100=0`
  await db.prepare(refundSql).bind(ownerId, tenantId).run()

  const summarySql = `
    WITH RECURSIVE days(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM days WHERE n<365)
    INSERT OR REPLACE INTO restaurant_daily_summaries
      (tenant_id,business_date,order_count,revenue_minor,tax_minor,cancelled_count,refunds_minor,average_order_minor,metrics)
    SELECT ?,date('now',printf('-%d days',365-days.n)),3,31500,1500,0,
      CASE WHEN days.n%100=0 THEN 500 ELSE 0 END,10500,
      '{"source":"seeded-demo","sampled":true}'
    FROM days`
  await db.prepare(summarySql).bind(tenantId).run()

  const liveSession = 'demo-session-live'
  await db.prepare(`INSERT OR IGNORE INTO restaurant_table_sessions
    (id,tenant_id,table_id,status,guest_count,opened_by)
    SELECT ?,?,id,'open',2,? FROM restaurant_tables WHERE tenant_id=? AND table_number=10`)
    .bind(liveSession, tenantId, waiterId, tenantId).run()
  await db.prepare(`INSERT OR IGNORE INTO restaurant_orders
    (id,tenant_id,order_number,table_id,session_id,status,subtotal_minor,tax_minor,total_minor,
     source,idempotency_key,placed_by,tax_mode_snapshot,tax_rate_snapshot,tax_inclusive_snapshot)
    SELECT 'demo-order-live',?,1099,id,?,'new',8500,425,8925,'qr','demo-key-live',?,
      'gst',5,0 FROM restaurant_tables WHERE tenant_id=? AND table_number=10`)
    .bind(tenantId, liveSession, waiterId, tenantId).run()
  await db.prepare(`INSERT OR IGNORE INTO restaurant_order_items
    (id,tenant_id,order_id,item_id,category_id,item_name_snapshot,quantity,unit_price_minor,
     addons_price_minor,line_total_minor,status)
    VALUES('demo-line-live',?,?,?,?,'{"en":"Masala Dosa","kn":"ಮಸಾಲೆ ದೋಸೆ"}',1,8500,0,8500,'new')`)
    .bind(tenantId, 'demo-order-live', menuItemId, categoryId).run()
  await db.prepare(`INSERT OR IGNORE INTO restaurant_service_requests
    (id,tenant_id,session_id,table_id,request_type,note,status)
    SELECT 'demo-request-live',?,? ,id,'call_waiter','Sample open request for waiter demo','open'
    FROM restaurant_tables WHERE tenant_id=? AND table_number=10`)
    .bind(tenantId, liveSession, tenantId).run()
  await db.prepare(`
    INSERT OR IGNORE INTO restaurant_activity_events(id,tenant_id,actor_staff_id,severity,action,detail)
    VALUES('demo-history-seeded-'||?, ?,?,'info','demo.history.seeded','{"orders":1095,"days":365,"payments":"simulated","live_order":true}')
  `).bind(tenantId, tenantId, ownerId).run()
}

export async function handleDemoProvision(request: Request, env: Env, admin: Identity): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  if (!env.DEMO_DB) return json(503, { error: 'demo_storage_not_configured' })

  const db = env.DEMO_DB
  try {
    const existing = await db.prepare("SELECT id FROM tenants WHERE slug=? LIMIT 1")
      .bind(DEMO_SLUG).first<{ id: string }>()
    const application = await db.prepare("SELECT id FROM applications WHERE app_key='restaurant' AND status='active' LIMIT 1")
      .first<{ id: string }>()
    if (!application) return json(503, { error: 'restaurant_application_not_configured_in_demo_db' })

    const tenantId = existing?.id || crypto.randomUUID()
    const userId = (await db.prepare('SELECT id FROM platform_users WHERE auth_provider=? AND auth_subject=?')
      .bind(admin.issuer, admin.subject).first<{ id: string }>())?.id || crypto.randomUUID()
    const ownerId = (await db.prepare("SELECT id FROM restaurant_staff WHERE tenant_id=? AND username='demo-owner'")
      .bind(tenantId).first<{ id: string }>())?.id || crypto.randomUUID()

    await db.batch([
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
        .bind(ownerId, tenantId, userId),
      db.prepare("INSERT OR IGNORE INTO restaurant_tenant_controls(tenant_id) VALUES(?)").bind(tenantId),
      db.prepare("INSERT INTO restaurant_menu_categories(id,tenant_id,name,sort_order,station) SELECT ?,?,?,1,'kitchen' WHERE NOT EXISTS (SELECT 1 FROM restaurant_menu_categories WHERE tenant_id=? AND json_extract(name,'$.en')='South Indian')")
        .bind(crypto.randomUUID(), tenantId, JSON.stringify({ en: 'South Indian', kn: 'ದಕ್ಷಿಣ ಭಾರತೀಯ' }), tenantId),
      db.prepare("INSERT INTO restaurant_menu_categories(id,tenant_id,name,sort_order,station) SELECT ?,?,?,2,'kitchen' WHERE NOT EXISTS (SELECT 1 FROM restaurant_menu_categories WHERE tenant_id=? AND json_extract(name,'$.en')='North Indian')")
        .bind(crypto.randomUUID(), tenantId, JSON.stringify({ en: 'North Indian', kn: 'ಉತ್ತರ ಭಾರತೀಯ' }), tenantId),
      db.prepare("INSERT INTO restaurant_menu_categories(id,tenant_id,name,sort_order,station) SELECT ?,?,?,3,'beverage' WHERE NOT EXISTS (SELECT 1 FROM restaurant_menu_categories WHERE tenant_id=? AND json_extract(name,'$.en')='Beverages')")
        .bind(crypto.randomUUID(), tenantId, JSON.stringify({ en: 'Beverages', kn: 'ಪಾನೀಯಗಳು' }), tenantId),
    ])

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

    const cookId = await ensureDemoStaffAccount(db, tenantId, 'cook', 'demo.cook', 'Demo Cook', 'DemoCook#2026!')
    const waiterId = await ensureDemoStaffAccount(db, tenantId, 'waiter', 'demo.waiter', 'Demo Waiter', 'DemoWaiter#2026!')
    await ensureDemoStaffAccount(db, tenantId, 'manager', 'demo.manager', 'Demo Manager', 'DemoManager#2026!')

    const tableTokens: Array<{ label: string; url: string }> = []
    const qrMap: Record<string, string> = {}
    for (let n = 1; n <= 10; n++) {
      const qr = await stableToken('platform-core-demo-qr-' + n)
      const hash = await digest(qr)
      const label = 'Table ' + n
      await db.prepare(`INSERT INTO restaurant_tables(tenant_id,table_number,label,table_type,public_token_hash)
        VALUES(?,?,?,'dine_in',?)
        ON CONFLICT(tenant_id,table_number) DO UPDATE SET label=excluded.label,public_token_hash=excluded.public_token_hash,active=1`)
        .bind(tenantId, n, label, hash).run()
      const row = await db.prepare('SELECT id FROM restaurant_tables WHERE tenant_id=? AND table_number=?')
        .bind(tenantId, n).first<{ id: string }>()
      if (row) {
        qrMap[row.id] = qr
        tableTokens.push({ label, url: '/r/' + DEMO_SLUG + '/' + qr })
      }
    }
    await db.prepare(`INSERT INTO restaurant_settings(tenant_id,setting_key,setting_value,updated_by)
      VALUES(?,'demo_qr_tokens',?,?)
      ON CONFLICT(tenant_id,setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .bind(tenantId, JSON.stringify(qrMap), ownerId).run()

    const menuItem = await db.prepare("SELECT id,category_id FROM restaurant_menu_items WHERE tenant_id=? ORDER BY sort_order LIMIT 1")
      .bind(tenantId).first<{ id: string; category_id: string }>()
    if (!menuItem) throw new Error('demo_menu_seed_failed')
    // Every statement in seedHistory is idempotent, so a retry repairs a
    // partially completed first-time seed instead of leaving an incomplete demo.
    await seedHistory(db, tenantId, ownerId, cookId, waiterId, menuItem.id, menuItem.category_id)

    await db.prepare(`
      INSERT INTO restaurant_activity_events(tenant_id,actor_staff_id,severity,action,detail)
      VALUES(?,?,'info','demo.workspace.provisioned','{"storage":"isolated-demo-d1"}')
    `).bind(tenantId, ownerId).run()

    return json(200, {
      provisioned: true,
      tenant: { id: tenantId, name: 'Platform Demo Restaurant', slug: DEMO_SLUG },
      history: { days: 365, orders: 1095, payments: 'simulated', reviews: 'sampled with owner replies' },
      qr_codes: tableTokens,
      note: 'All demo records are stored only in the isolated demo database. Payments are simulated; no real money is moved.',
    })
  } catch (error) {
    return json(500, { error: 'demo_provision_failed', detail: error instanceof Error ? error.message : 'unknown_error' })
  }
}
