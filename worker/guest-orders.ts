import type { Env } from './types.ts'

const TOKEN = /^[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
}
function bad(status: number, code: string): never { throw Object.assign(new Error(code), { status }) }
function error(error: unknown) {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500
  return json(status, { error: error instanceof Error && status < 500 ? error.message : 'order_placement_failed' })
}
function parse(value: unknown) { try { return typeof value === 'string' ? JSON.parse(value) : value } catch { return {} } }

export async function handleGuestOrder(request: Request, env: Env, tenantId: string, token: string) {
  try {
    if (!TOKEN.test(token)) return json(404, { error: 'qr_not_found' })
    const raw = await request.text()
    if (new TextEncoder().encode(raw).byteLength > 8192) bad(413, 'payload_too_large')
    let body: Record<string, unknown>
    try { body = JSON.parse(raw) } catch { bad(400, 'invalid_json') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) bad(400, 'invalid_order')
    const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
    const key = typeof body.idempotency_key === 'string' ? body.idempotency_key : ''
    const items = body.items
    if (!UUID.test(sessionId) || !/^[A-Za-z0-9_-]{12,100}$/.test(key) || !Array.isArray(items) || items.length < 1 || items.length > 20) bad(400, 'invalid_order')
    const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
    const tokenHash = [...hashBytes].map(x => x.toString(16).padStart(2, '0')).join('')
    const table = await env.DB.prepare("SELECT id FROM restaurant_tables WHERE tenant_id=? AND public_token_hash=? AND active=1").bind(tenantId, tokenHash).first<{id:string}>()
    if (!table) bad(404, 'qr_not_found')
    const session = await env.DB.prepare("SELECT id FROM restaurant_table_sessions WHERE tenant_id=? AND table_id=? AND id=? AND status='open'").bind(tenantId, table.id, sessionId).first()
    if (!session) bad(409, 'table_session_not_open')
    const profile = await env.DB.prepare('SELECT accepting_orders,tax_mode,tax_rate,gst_rate,tax_inclusive FROM restaurant_profiles WHERE tenant_id=?').bind(tenantId).first<Record<string, unknown>>()
    if (!profile || !Boolean(profile.accepting_orders)) bad(409, 'restaurant_not_accepting_orders')
    const prior = await env.DB.prepare('SELECT id,order_number,status,total_minor FROM restaurant_orders WHERE tenant_id=? AND session_id=? AND idempotency_key=?').bind(tenantId, sessionId, key).first<Record<string, unknown>>()
    if (prior) return json(200, { order: prior })
    const prepared: Array<{id:string;itemId:string;variantId:string|null;categoryId:string;name:string;variantName:string|null;addons:string;qty:number;unit:number;addonUnit:number;line:number}> = []
    for (const input of items) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.item_id !== 'string' || !UUID.test(input.item_id) || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 20 || (input.addon_ids !== undefined && (!Array.isArray(input.addon_ids) || input.addon_ids.length > 20))) bad(400, 'invalid_order_item')
      const item = await env.DB.prepare("SELECT i.id,i.category_id,i.name,i.base_price_minor,i.available,i.active,i.stock_tracking,i.stock_quantity FROM restaurant_menu_items i JOIN restaurant_menu_categories c ON c.tenant_id=i.tenant_id AND c.id=i.category_id AND c.active=1 WHERE i.tenant_id=? AND i.id=?").bind(tenantId, input.item_id).first<Record<string, unknown>>()
      if (!item || !Boolean(item.active) || !Boolean(item.available)) bad(409, 'no_orderable_items')
      
      let unit = Number(item.base_price_minor), variantId: string|null = null, variantName: string|null = null
      const variants = await env.DB.prepare("SELECT id,name,price_minor,available FROM restaurant_menu_variants WHERE tenant_id=? AND item_id=? AND active=1 ORDER BY sort_order,id").bind(tenantId,item.id).all<Record<string, unknown>>()
      if (variants.results.length) {
        if (typeof input.variant_id !== 'string' || !UUID.test(input.variant_id)) bad(400, 'variant_required')
        const variant = variants.results.find(v => v.id === input.variant_id)
        if (!variant) bad(400, 'invalid_variant')
        if (!Boolean(variant.available)) bad(409, 'no_orderable_items')
        variantId=String(variant.id); variantName=String(parse(variant.name)?.en || Object.values(parse(variant.name) || {})[0] || '')
        unit=Number(variant.price_minor)
      } else if (input.variant_id !== undefined) bad(400, 'invalid_variant')
      const addonIds: string[] = [...new Set(((input.addon_ids || []) as unknown[]).map((id: unknown) => typeof id === 'string' ? id : ''))]
      if (addonIds.some(id => !UUID.test(id))) bad(400, 'invalid_order_item')
      const groups = await env.DB.prepare("SELECT g.id,g.required,g.min_pick,g.max_pick FROM restaurant_item_addon_groups ig JOIN restaurant_addon_groups g ON g.tenant_id=ig.tenant_id AND g.id=ig.group_id AND g.active=1 WHERE ig.tenant_id=? AND ig.item_id=?").bind(tenantId,item.id).all<Record<string, unknown>>()
      const allowedGroups = groups.results
      const addonRows = addonIds.length ? await env.DB.prepare(`SELECT a.id,a.group_id,a.name,a.price_minor FROM restaurant_addons a WHERE a.tenant_id=? AND a.active=1 AND a.available=1 AND a.id IN (${addonIds.map(()=>'?').join(',')})`).bind(tenantId,...addonIds).all<Record<string, unknown>>() : {results:[]}
      if (addonRows.results.length !== addonIds.length || addonRows.results.some(a => !allowedGroups.some(g => g.id === a.group_id))) bad(400, 'invalid_addon_selection')
      for (const group of allowedGroups) {
        const count = addonRows.results.filter(a => a.group_id === group.id).length
        if (count < Number(group.min_pick) || (Boolean(group.required) && count === 0) || count > Number(group.max_pick)) bad(400, 'invalid_addon_selection')
      }
      const addonUnit = addonRows.results.reduce((n,a)=>n+Number(a.price_minor),0)
      const addonSnapshot = JSON.stringify(addonRows.results.map(a=>({id:a.id,name:parse(a.name),price_minor:a.price_minor})))
      const quantity=Number(input.quantity), line=quantity*(unit+addonUnit)
      if (!Number.isSafeInteger(line) || line < 0) bad(400, 'invalid_order_item')
      prepared.push({id:crypto.randomUUID(),itemId:String(item.id),variantId,categoryId:String(item.category_id),name:String(parse(item.name)?.en || Object.values(parse(item.name)||{})[0] || 'Menu item'),variantName,addons:addonSnapshot,qty:quantity,unit,addonUnit,line})
    }
    const grossSubtotal=prepared.reduce((n,x)=>n+x.line,0)
    if (!Number.isSafeInteger(grossSubtotal)) bad(400,'invalid_order')
    const demand = new Map<string, number>()
    for (const line of prepared) {
      const item = await env.DB.prepare('SELECT stock_tracking,stock_quantity FROM restaurant_menu_items WHERE tenant_id=? AND id=?').bind(tenantId,line.itemId).first<Record<string, unknown>>()
      if (item && Boolean(item.stock_tracking)) demand.set(line.itemId,(demand.get(line.itemId)||0)+line.qty)
    }
    for (const [itemId,quantity] of demand) {
      const stock = await env.DB.prepare('SELECT stock_quantity FROM restaurant_menu_items WHERE tenant_id=? AND id=?').bind(tenantId,itemId).first<{stock_quantity:number|null}>()
      if (!stock || stock.stock_quantity === null || Number(stock.stock_quantity) < quantity) bad(409,'insufficient_stock')
    }
    const mode=String(profile.tax_mode || 'none'), rate=mode==='gst'?Number(profile.gst_rate||0):mode==='single'?Number(profile.tax_rate||0):0
    const inclusive=Boolean(profile.tax_inclusive)
    const tax=mode==='none'?0:inclusive?Math.round(grossSubtotal*rate/(100+rate)):Math.round(grossSubtotal*rate/100)
    const subtotal=inclusive?grossSubtotal-tax:grossSubtotal
    const total=inclusive?grossSubtotal:grossSubtotal+tax
    if (!Number.isSafeInteger(total)) bad(400,'invalid_order')
    const orderId=crypto.randomUUID()
    const numberRow=await env.DB.prepare('SELECT COALESCE(MAX(order_number),0)+1 AS next_number FROM restaurant_orders WHERE tenant_id=?').bind(tenantId).first<{next_number:number}>()
    const orderNumber=Number(numberRow?.next_number || 1)
    const statements=[env.DB.prepare(`INSERT INTO restaurant_orders(id,tenant_id,order_number,table_id,session_id,status,subtotal_minor,tax_minor,total_minor,source,idempotency_key,tax_mode_snapshot,tax_rate_snapshot,tax_inclusive_snapshot) VALUES(?,?,?,?,?,'new',?,?,?,'qr',?,?,?,?)`).bind(orderId,tenantId,orderNumber,table.id,sessionId,subtotal,tax,total,key,mode,rate,Number(inclusive))]
    for(const line of prepared) {
      statements.push(env.DB.prepare(`INSERT INTO restaurant_order_items(id,tenant_id,order_id,item_id,variant_id,category_id,item_name_snapshot,variant_name_snapshot,addons_snapshot,quantity,unit_price_minor,addons_price_minor,line_total_minor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(line.id,tenantId,orderId,line.itemId,line.variantId,line.categoryId,line.name,line.variantName,line.addons,line.qty,line.unit,line.addonUnit,line.line))
      const batchKey = `guest:${orderId}:${line.id}`
      const batchId = crypto.randomUUID()
      statements.push(env.DB.prepare(`INSERT INTO restaurant_kitchen_batches(id,tenant_id,batch_key,item_name_snapshot,variant_name_snapshot,addons_snapshot,total_quantity,status) VALUES(?,?,?,?,?,?,?,'new')`).bind(batchId,tenantId,batchKey,line.name,line.variantName,line.addons,line.qty))
      statements.push(env.DB.prepare(`INSERT INTO restaurant_batch_allocations(id,tenant_id,batch_id,order_item_id,quantity,status) VALUES(?,?,?,?,?,'new')`).bind(crypto.randomUUID(),tenantId,batchId,line.id,line.qty))
    }
    for (const [itemId,quantity] of demand) {
      statements.push(env.DB.prepare(`UPDATE restaurant_menu_items SET stock_quantity=stock_quantity-?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id=? AND id=? AND stock_tracking=1 AND stock_quantity>=?`).bind(quantity,tenantId,itemId,quantity))
      statements.push(env.DB.prepare(`INSERT INTO restaurant_stock_events(tenant_id,item_id,quantity_delta,old_quantity,new_quantity,reason) SELECT ?,id,? ,stock_quantity+?,stock_quantity, 'order' FROM restaurant_menu_items WHERE tenant_id=? AND id=?`).bind(tenantId,-quantity,quantity,tenantId,itemId))
    }
    const result=await env.DB.batch(statements)
    if(result.some(r=>!r.success)) bad(409,'order_placement_conflict')
    return json(201,{order:{id:orderId,order_number:orderNumber,status:'new',subtotal_minor:subtotal,tax_minor:tax,total_minor:total}})
  } catch(e) { return error(e) }
}
