import type { Env } from './types.ts'

const TOKEN = /^[A-Za-z0-9_-]{40,48}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/
type Row = Record<string, unknown>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
}
function fail(status: number, code: string, extra: Row = {}): never {
  throw Object.assign(new Error(code), { status, extra })
}
function errorResponse(error: unknown, fallback: string): Response {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500
  const code = error instanceof Error && status < 500 ? error.message : fallback
  const extra = error && typeof error === 'object' && 'extra' in error ? error.extra : {}
  return json(status, { error: code, ...(extra && typeof extra === 'object' ? extra : {}) })
}
async function readBody(request: Request): Promise<Row> {
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > 16 * 1024) fail(413, 'payload_too_large')
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_order')
    return value as Row
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error
    fail(400, 'invalid_order')
  }
}
async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('')
}
function localized(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return String(source.en || source.hi || source.kn || 'Item')
  }
  return 'Item'
}
function normalizeCustomization(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u0900-\u097f\u0c80-\u0cff ]+/g, ' ').replace(/\s+/g, ' ').trim()
}
function calculateTaxMinor(subtotalMinor: bigint, mode: string, rateValue: unknown, inclusive: boolean) {
  const rateBasisPoints = BigInt(Math.round((Number(rateValue) || 0) * 10000))
  if (!['single','gst'].includes(mode) || rateBasisPoints <= 0n) return { tax: 0n, total: subtotalMinor }
  const numerator = subtotalMinor * rateBasisPoints
  const denominator = inclusive ? 1000000n + rateBasisPoints : 1000000n
  const tax = (numerator + denominator / 2n) / denominator
  return { tax, total: inclusive ? subtotalMinor : subtotalMinor + tax }
}
function parseSnapshot(value: unknown) {
  if (typeof value !== 'string') return []
  try { return JSON.parse(value) } catch { return [] }
}

async function prepareLine(env: Env, tenantId: string, line: unknown) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) fail(400, 'invalid_order_line')
  const input = line as Row
  if (typeof input.item_id !== 'string' || !UUID.test(input.item_id)) fail(400, 'invalid_order_line')
  const quantity = Number(input.quantity)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) fail(400, 'invalid_quantity')

  const item = await env.DB.prepare(
    `SELECT i.id,i.category_id,i.name,i.base_price_minor,i.food_type,i.available,i.stock_tracking,i.stock_quantity,i.active,
       c.active AS category_active
     FROM restaurant_menu_items i
     JOIN restaurant_menu_categories c ON c.tenant_id=i.tenant_id AND c.id=i.category_id
     WHERE i.tenant_id=? AND i.id=? LIMIT 1`,
  ).bind(tenantId, input.item_id).first<Row>()
  if (!item || !Number(item.active) || !Number(item.category_active) || !Number(item.available)) {
    return { removed: { item_id: input.item_id, reason: 'unavailable', name: item ? localized(item.name) : 'Item' } }
  }

  const variantResult = await env.DB.prepare(
    'SELECT id,name,price_minor,available FROM restaurant_menu_variants WHERE tenant_id=? AND item_id=? AND active=1 ORDER BY sort_order,id',
  ).bind(tenantId, item.id).all<Row>()
  let variant: Row | null = null
  if (variantResult.results.length) {
    variant = variantResult.results.find(row => row.id === input.variant_id) ?? null
    if (!variant) fail(400, 'variant_required')
    if (!Number(variant.available)) return { removed: { item_id: item.id, reason: 'variant_unavailable', name: localized(item.name) } }
  } else if (input.variant_id) fail(400, 'invalid_variant')

  const groupRows = await env.DB.prepare(
    `SELECT g.id AS group_id,g.name AS group_name,g.required,g.min_pick,g.max_pick,
       a.id AS addon_id,a.name AS addon_name,a.price_minor AS addon_price_minor,a.available AS addon_available
     FROM restaurant_item_addon_groups l
     JOIN restaurant_addon_groups g ON g.tenant_id=l.tenant_id AND g.id=l.group_id AND g.active=1
     LEFT JOIN restaurant_addons a ON a.tenant_id=g.tenant_id AND a.group_id=g.id AND a.active=1
     WHERE l.tenant_id=? AND l.item_id=?
     ORDER BY g.sort_order,g.id,a.sort_order,a.id`,
  ).bind(tenantId, item.id).all<Row>()
  const groups = new Map<string,{id:string;required:boolean;min:number;max:number;addons:Map<string,Row>}>()
  for (const row of groupRows.results) {
    const groupId = String(row.group_id)
    if (!groups.has(groupId)) groups.set(groupId,{id:groupId,required:Boolean(row.required),min:Number(row.min_pick),max:Number(row.max_pick),addons:new Map()})
    if (row.addon_id) groups.get(groupId)!.addons.set(String(row.addon_id),row)
  }

  if (input.addon_ids !== undefined && !Array.isArray(input.addon_ids)) fail(400, 'invalid_addons')
  const selectedIds = Array.isArray(input.addon_ids) ? [...new Set(input.addon_ids)] : []
  if (selectedIds.some(id => typeof id !== 'string' || !UUID.test(id))) fail(400, 'invalid_addons')
  const selected: Row[] = []
  const counts = new Map<string,number>()
  for (const addonId of selectedIds as string[]) {
    let found: {group:{id:string;required:boolean;min:number;max:number;addons:Map<string,Row>};addon:Row} | null = null
    for (const group of groups.values()) {
      const addon = group.addons.get(addonId)
      if (addon) { found = {group,addon}; break }
    }
    if (!found) fail(400, 'invalid_addon')
    if (!Number(found.addon.addon_available)) return { removed: { item_id: item.id, reason: 'addon_unavailable', name: localized(item.name) } }
    selected.push(found.addon)
    counts.set(found.group.id,(counts.get(found.group.id)||0)+1)
  }
  for (const group of groups.values()) {
    const count=counts.get(group.id)||0
    const minimum=group.required?Math.max(1,group.min):group.min
    if(count<minimum||count>group.max) fail(400,'invalid_addon_selection')
  }

  const unitPrice=BigInt(String(variant?.price_minor ?? item.base_price_minor))
  const addonPrice=selected.reduce((sum,addon)=>sum+BigInt(String(addon.addon_price_minor)),0n)
  const customization=typeof input.customization==='string'?input.customization.replace(/\s+/g,' ').trim().slice(0,100):''
  return {
    item,variant,quantity,unitPrice,addonPrice,customization,customizationKey:normalizeCustomization(customization),
    addonSnapshot:selected.map(addon=>({id:addon.addon_id,name:addon.addon_name,price_minor:String(addon.addon_price_minor)})),
    lineTotal:BigInt(quantity)*(unitPrice+addonPrice),
  }
}

async function guestTable(env: Env, tenantId: string, token: string): Promise<Row | null> {
  if (!TOKEN.test(token)) return null
  const hash=await hashToken(token)
  return await env.DB.prepare('SELECT id,label FROM restaurant_tables WHERE tenant_id=? AND public_token_hash=? AND active=1 LIMIT 1').bind(tenantId,hash).first<Row>()
}

export async function handleGuestOrder(request: Request, env: Env, tenantId: string, token: string): Promise<Response> {
  if(!TOKEN.test(token)) return json(404,{error:'qr_not_found'})
  if(request.method!=='POST') return json(405,{error:'method_not_allowed'})
  try {
    const input=await readBody(request)
    if(!Array.isArray(input.items)||input.items.length<1||input.items.length>30) fail(400,'invalid_order_items')
    if(typeof input.session_id!=='string'||!UUID.test(input.session_id)) fail(400,'table_session_required')
    if(typeof input.idempotency_key!=='string'||!IDEMPOTENCY_KEY.test(input.idempotency_key)) fail(400,'invalid_idempotency_key')
    const note=typeof input.note==='string'?input.note.replace(/\s+/g,' ').trim().slice(0,200):''
    const table=await guestTable(env,tenantId,token)
    if(!table) fail(404,'qr_not_found')
    const session=await env.DB.prepare("SELECT id FROM restaurant_table_sessions WHERE tenant_id=? AND table_id=? AND id=? AND status='open' LIMIT 1").bind(tenantId,table.id,input.session_id).first()
    if(!session) fail(409,'table_session_not_open')

    const duplicate=await env.DB.prepare('SELECT id,order_number,status,subtotal_minor,tax_minor,total_minor,created_at FROM restaurant_orders WHERE tenant_id=? AND session_id=? AND idempotency_key=? LIMIT 1').bind(tenantId,input.session_id,input.idempotency_key).first<Row>()
    if(duplicate) return json(200,{duplicate:true,order:duplicate,removed:[]})

    const profile=await env.DB.prepare('SELECT accepting_orders,tax_mode,tax_rate,gst_rate,tax_inclusive FROM restaurant_profiles WHERE tenant_id=?').bind(tenantId).first<Row>()
    if(profile&&!Number(profile.accepting_orders)) fail(409,'restaurant_not_accepting_orders')
    const recent=await env.DB.prepare("SELECT count(*) AS recent_count FROM restaurant_orders WHERE tenant_id=? AND session_id=? AND created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')").bind(tenantId,input.session_id).first<Row>()
    if(Number(recent?.recent_count||0)>=5) fail(429,'order_rate_limited')

    const prepared:Row[]=[]
    const removed:Row[]=[]
    for(const line of input.items){
      const result=await prepareLine(env,tenantId,line)
      if('removed' in result) removed.push(result.removed as Row)
      else prepared.push(result as Row)
    }
    const demand=new Map<string,number>()
    for(const line of prepared){
      if(Number((line.item as Row).stock_tracking)) demand.set(String((line.item as Row).id),(demand.get(String((line.item as Row).id))||0)+Number(line.quantity))
    }
    const rejected=new Set<string>()
    for(const [itemId,quantity] of demand){
      const line=prepared.find(entry=>String((entry.item as Row).id)===itemId)!
      const stock=(line.item as Row).stock_quantity
      if(stock===null||Number(stock)<quantity){
        rejected.add(itemId)
        removed.push({item_id:itemId,reason:'insufficient_stock',name:localized((line.item as Row).name)})
      }
    }
    const accepted=prepared.filter(line=>!rejected.has(String((line.item as Row).id)))
    if(!accepted.length) fail(409,'no_orderable_items',{removed})

    const grossSubtotal=accepted.reduce((sum,line)=>sum+BigInt(String(line.lineTotal)),0n)
    const taxMode=String(profile?.tax_mode||'none')
    const taxRate=taxMode==='gst'?(profile?.gst_rate??0):(profile?.tax_rate??0)
    const inclusive=Boolean(profile?.tax_inclusive)
    const tax=calculateTaxMinor(grossSubtotal,taxMode,taxRate,inclusive)
    if(tax.total>9000000000000000n) fail(400,'order_total_too_large')
    const netSubtotal=inclusive?grossSubtotal-tax.tax:grossSubtotal
    const orderId=crypto.randomUUID()
    const updatedAt=new Date().toISOString()

    const demandEntries=[...demand.entries()].filter(([id])=>!rejected.has(id))
    let stockCondition='1=1'
    let stockParams:unknown[]=[]
    if(demandEntries.length){
      const ids=demandEntries.map(([id])=>id)
      const caseSql='CASE id '+demandEntries.map(()=> 'WHEN ? THEN ?').join(' ')+' ELSE 0 END'
      stockCondition=`(SELECT count(*) FROM restaurant_menu_items WHERE tenant_id=? AND id IN (${ids.map(()=>'?').join(',')}) AND stock_tracking=1 AND stock_quantity IS NOT NULL AND stock_quantity >= ${caseSql}) = ?`
      stockParams=[tenantId,...ids,...demandEntries.flatMap(([id,qty])=>[id,qty]),demandEntries.length]
    }

    const statements=[]
    const orderSql=`INSERT INTO restaurant_orders
      (id,tenant_id,order_number,table_id,session_id,status,subtotal_minor,tax_minor,total_minor,special_instructions,source,idempotency_key,tax_mode_snapshot,tax_rate_snapshot,tax_inclusive_snapshot)
      SELECT ?,?,(SELECT COALESCE(MAX(order_number),0)+1 FROM restaurant_orders WHERE tenant_id=?),?,?,'new',?,?,?,?,'qr',?,?,?,?
      WHERE ${stockCondition}
      ON CONFLICT(tenant_id,session_id,idempotency_key) DO NOTHING
      RETURNING id,order_number,status,subtotal_minor,tax_minor,total_minor,created_at`
    statements.push(env.DB.prepare(orderSql).bind(orderId,tenantId,tenantId,table.id,input.session_id,String(netSubtotal),String(tax.tax),String(tax.total),note,input.idempotency_key,taxMode,Number(taxRate)||0,Number(inclusive),...stockParams))

    if(demandEntries.length){
      const ids=demandEntries.map(([id])=>id)
      const caseSql='CASE id '+demandEntries.map(()=> 'WHEN ? THEN ?').join(' ')+' ELSE 0 END'
      const updateSql=`UPDATE restaurant_menu_items SET stock_quantity=ROUND(stock_quantity-(${caseSql}),3),updated_at=?
        WHERE tenant_id=? AND id IN (${ids.map(()=>'?').join(',')}) AND stock_tracking=1
        AND EXISTS(SELECT 1 FROM restaurant_orders WHERE tenant_id=? AND id=?)`
      statements.push(env.DB.prepare(updateSql).bind(...demandEntries.flatMap(([id,qty])=>[id,qty]),updatedAt,tenantId,...ids,tenantId,orderId))

      const values=demandEntries.map(()=>'(?,?)').join(',')
      const eventSql=`WITH demand(item_id,quantity) AS (VALUES ${values})
        INSERT INTO restaurant_stock_events(tenant_id,item_id,quantity_delta,old_quantity,new_quantity,reason)
        SELECT ?,d.item_id,-d.quantity,i.stock_quantity+d.quantity,i.stock_quantity,'order'
        FROM demand d JOIN restaurant_menu_items i ON i.tenant_id=? AND i.id=d.item_id
        WHERE EXISTS(SELECT 1 FROM restaurant_orders WHERE tenant_id=? AND id=?)`
      statements.push(env.DB.prepare(eventSql).bind(...demandEntries.flatMap(([id,qty])=>[id,qty]),tenantId,tenantId,tenantId,orderId))
    }

    const itemRows=accepted.map(line=>{
      const item=line.item as Row, variant=line.variant as Row|null
      const itemId=crypto.randomUUID(),batchId=crypto.randomUUID(),allocationId=crypto.randomUUID()
      return {line,item,itemId,batchId,allocationId,variant,batchKey:orderId+':'+itemId}
    })
    const itemValues=itemRows.map(()=> '('+Array(15).fill('?').join(',')+')').join(',')
    const itemSql=`WITH rows(id,tenant_id,order_id,item_id,variant_id,category_id,item_name_snapshot,variant_name_snapshot,addons_snapshot,customization,customization_key,quantity,unit_price_minor,addons_price_minor,line_total_minor) AS (VALUES ${itemValues})
      INSERT INTO restaurant_order_items(id,tenant_id,order_id,item_id,variant_id,category_id,item_name_snapshot,variant_name_snapshot,addons_snapshot,customization,customization_key,quantity,unit_price_minor,addons_price_minor,line_total_minor,status)
      SELECT id,tenant_id,order_id,item_id,variant_id,category_id,item_name_snapshot,variant_name_snapshot,addons_snapshot,customization,customization_key,quantity,unit_price_minor,addons_price_minor,line_total_minor,'new'
      FROM rows WHERE EXISTS(SELECT 1 FROM restaurant_orders WHERE tenant_id=? AND id=?)`
    statements.push(env.DB.prepare(itemSql).bind(...itemRows.flatMap(({line,item,itemId,variant})=>[
      itemId,tenantId,orderId,item.id,variant?.id??null,item.category_id,localized(item.name),variant?localized(variant.name):null,
      JSON.stringify(line.addonSnapshot),line.customization,line.customizationKey,line.quantity,String(line.unitPrice),String(line.addonPrice),String(line.lineTotal)
    ]),tenantId,orderId))

    const batchValues=itemRows.map(()=> '('+Array(8).fill('?').join(',')+')').join(',')
    const batchSql=`WITH rows(id,tenant_id,batch_key,item_name_snapshot,variant_name_snapshot,addons_snapshot,customization_key,total_quantity) AS (VALUES ${batchValues})
      INSERT INTO restaurant_kitchen_batches(id,tenant_id,batch_key,item_name_snapshot,variant_name_snapshot,addons_snapshot,customization_key,total_quantity,status)
      SELECT id,tenant_id,batch_key,item_name_snapshot,variant_name_snapshot,addons_snapshot,customization_key,total_quantity,'new'
      FROM rows WHERE EXISTS(SELECT 1 FROM restaurant_orders WHERE tenant_id=? AND id=?)`
    statements.push(env.DB.prepare(batchSql).bind(...itemRows.flatMap(({line,item,itemId,batchId,variant,batchKey})=>[
      batchId,tenantId,batchKey,localized(item.name),variant?localized(variant.name):null,JSON.stringify(line.addonSnapshot),line.customizationKey,line.quantity
    ]),tenantId,orderId))

    const allocationValues=itemRows.map(()=> '(?,?,?,?,?)').join(',')
    const allocationSql=`WITH rows(id,tenant_id,batch_id,order_item_id,quantity) AS (VALUES ${allocationValues})
      INSERT INTO restaurant_batch_allocations(id,tenant_id,batch_id,order_item_id,quantity,status)
      SELECT id,tenant_id,batch_id,order_item_id,quantity,'new'
      FROM rows WHERE EXISTS(SELECT 1 FROM restaurant_orders WHERE tenant_id=? AND id=?)`
    statements.push(env.DB.prepare(allocationSql).bind(...itemRows.flatMap(({line,itemId,batchId,allocationId})=>[
      allocationId,tenantId,batchId,itemId,line.quantity
    ]),tenantId,orderId))

    if(removed.length){
      statements.push(env.DB.prepare(`INSERT INTO restaurant_service_requests(tenant_id,session_id,table_id,request_type,note)
        SELECT ?,?,?,'other',? WHERE EXISTS(SELECT 1 FROM restaurant_orders WHERE tenant_id=? AND id=?)`)
        .bind(tenantId,input.session_id,table.id,'Some unavailable items were removed from the submitted cart',tenantId,orderId))
    }

    const results=await env.DB.batch(statements)
    const order=results[0]?.results?.[0] as Row|undefined
    if(!order){
      const existing=await env.DB.prepare('SELECT id,order_number,status,subtotal_minor,tax_minor,total_minor,created_at FROM restaurant_orders WHERE tenant_id=? AND session_id=? AND idempotency_key=? LIMIT 1').bind(tenantId,input.session_id,input.idempotency_key).first<Row>()
      if(existing) return json(200,{duplicate:true,order:existing,removed:[]})
      fail(409,'stock_changed_retry',{removed})
    }
    return json(201,{duplicate:false,order,removed})
  }catch(error){return errorResponse(error,'order_placement_failed')}
}

export async function handleGuestLifecycle(request: Request, env: Env, tenantId: string, token: string, parts: string[]): Promise<Response> {
  if(!TOKEN.test(token)) return json(404,{error:'qr_not_found'})
  try {
    if(parts[4]==='orders'&&parts.length===6&&request.method==='GET'){
      const table=await guestTable(env,tenantId,token)
      if(!table) fail(404,'qr_not_found')
      if(!UUID.test(parts[5])) fail(404,'order_not_found')
      const order=await env.DB.prepare(`SELECT id,order_number,status,subtotal_minor,tax_minor,total_minor,special_instructions,created_at,ready_at,served_at
        FROM restaurant_orders WHERE tenant_id=? AND table_id=? AND id=?`).bind(tenantId,table.id,parts[5]).first<Row>()
      if(!order) fail(404,'order_not_found')
      const items=await env.DB.prepare(`SELECT id,item_name_snapshot,variant_name_snapshot,addons_snapshot,customization,quantity,
        unit_price_minor,addons_price_minor,line_total_minor,status,ready_at,served_at,unavailable_reason
        FROM restaurant_order_items WHERE tenant_id=? AND order_id=? ORDER BY created_at,id`).bind(tenantId,parts[5]).all<Row>()
      return json(200,{order,items:items.results.map(row=>({...row,addons_snapshot:parseSnapshot(row.addons_snapshot)}))})
    }

    if(parts[4]==='orders'&&parts.length===7&&parts[6]==='cancel'&&request.method==='POST'){
      const input=await readBody(request)
      if(!UUID.test(parts[5])||!UUID.test(input.session_id||'')) fail(400,'invalid_cancel_request')
      const table=await guestTable(env,tenantId,token)
      if(!table) fail(404,'qr_not_found')
      const session=await env.DB.prepare("SELECT id FROM restaurant_table_sessions WHERE tenant_id=? AND table_id=? AND id=? AND status='open'").bind(tenantId,table.id,input.session_id).first()
      if(!session) fail(409,'table_session_not_open')
      const order=await env.DB.prepare('SELECT id FROM restaurant_orders WHERE tenant_id=? AND table_id=? AND session_id=? AND id=?').bind(tenantId,table.id,input.session_id,parts[5]).first()
      if(!order) fail(404,'order_not_found')
      const itemId=input.order_item_id??null
      if(itemId!==null){
        if(!UUID.test(itemId)) fail(400,'invalid_order_item')
        const item=await env.DB.prepare('SELECT id,status FROM restaurant_order_items WHERE tenant_id=? AND order_id=? AND id=?').bind(tenantId,parts[5],itemId).first<Row>()
        if(!item) fail(404,'order_item_not_found')
        if(!['new','accepted'].includes(String(item.status))) fail(409,'cancellation_window_closed')
      }else{
        const preparing=await env.DB.prepare("SELECT count(*) AS count FROM restaurant_order_items WHERE tenant_id=? AND order_id=? AND status IN ('preparing','ready','served')").bind(tenantId,parts[5]).first<Row>()
        if(Number(preparing?.count)>0) fail(409,'cancellation_window_closed')
      }
      const inserted=await env.DB.prepare(`INSERT INTO restaurant_service_requests(tenant_id,session_id,table_id,request_type,note,order_id,order_item_id)
        VALUES(?,?,?,'cancel_order',?,?,?) RETURNING id,status,created_at`).bind(tenantId,input.session_id,table.id,'Customer requested order cancellation',parts[5],itemId).all<Row>()
      return json(201,{request:inserted.results[0]})
    }

    if(parts[4]==='requests'&&parts.length===5&&request.method==='POST'){
      const input=await readBody(request)
      const type=input.request_type
      if(!UUID.test(input.session_id||'')||!['call_waiter','need_water','request_bill','other'].includes(String(type))) fail(400,'invalid_service_request')
      const note=typeof input.note==='string'?input.note.trim().slice(0,250):''
      const table=await guestTable(env,tenantId,token)
      if(!table) fail(404,'qr_not_found')
      const session=await env.DB.prepare("SELECT id FROM restaurant_table_sessions WHERE tenant_id=? AND table_id=? AND id=? AND status='open'").bind(tenantId,table.id,input.session_id).first()
      if(!session) fail(409,'table_session_not_open')
      const inserted=await env.DB.prepare('INSERT INTO restaurant_service_requests(tenant_id,session_id,table_id,request_type,note) VALUES(?,?,?,?,?) RETURNING id,status,created_at').bind(tenantId,input.session_id,table.id,type,note).all<Row>()
      return json(201,{request:inserted.results[0]})
    }

    if(parts[4]==='reviews'&&parts.length===5&&request.method==='GET'){
      const table=await guestTable(env,tenantId,token)
      if(!table) fail(404,'qr_not_found')
      const row=await env.DB.prepare(`SELECT s.id,s.closed_at,(r.id IS NOT NULL) AS already_reviewed
        FROM restaurant_table_sessions s LEFT JOIN restaurant_reviews r ON r.tenant_id=s.tenant_id AND r.session_id=s.id
        WHERE s.tenant_id=? AND s.table_id=? AND s.status='closed'
          AND s.closed_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
        ORDER BY s.closed_at DESC LIMIT 1`).bind(tenantId,table.id).first<Row>()
      return json(200,{review_session:row&&!Number(row.already_reviewed)?{id:row.id,closed_at:row.closed_at}:null,already_reviewed:Boolean(row?.already_reviewed)})
    }

    if(parts[4]==='reviews'&&parts.length===5&&request.method==='POST'){
      const input=await readBody(request)
      const rating=Number(input.rating)
      if(!UUID.test(input.session_id||'')||!Number.isInteger(rating)||rating<1||rating>5) fail(400,'invalid_review')
      const comment=typeof input.comment==='string'?input.comment.trim().slice(0,1000):''
      const table=await guestTable(env,tenantId,token)
      if(!table) fail(404,'qr_not_found')
      const session=await env.DB.prepare("SELECT id FROM restaurant_table_sessions WHERE tenant_id=? AND table_id=? AND id=? AND status='closed'").bind(tenantId,table.id,input.session_id).first()
      if(!session) fail(409,'review_available_after_session_close')
      const inserted=await env.DB.prepare('INSERT INTO restaurant_reviews(tenant_id,session_id,table_id,rating,comment) VALUES(?,?,?,?,?) RETURNING id,rating,comment,created_at').bind(tenantId,input.session_id,table.id,rating,comment).all<Row>()
      return json(201,{review:inserted.results[0]})
    }
    return json(404,{error:'guest_route_not_found'})
  }catch(error){return errorResponse(error,'guest_request_failed')}
}
