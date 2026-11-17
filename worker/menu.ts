import type { Env } from './types.ts'

interface Actor { tenantId: string; userId: string; staffId: string | null; role: string }
type Row = Record<string, unknown>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
}
function fail(status: number, code: string): never { throw Object.assign(new Error(code), { status }) }
function errorResponse(error: unknown): Response {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500
  return json(status, { error: error instanceof Error && status < 500 ? error.message : 'menu_request_failed' })
}
async function body(request: Request): Promise<Row> {
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > 8192) fail(413, 'payload_too_large')
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_json')
    return value as Row
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error
    fail(400, 'invalid_json')
  }
}
function localized(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_localized_name')
  const source = value as Record<string, unknown>
  const keys = Object.keys(source)
  if (!keys.length || keys.some(key => !['en','hi','kn'].includes(key))) fail(400, 'invalid_localized_name')
  const result: Record<string,string> = {}
  for (const key of keys) {
    if (typeof source[key] !== 'string' || !source[key].trim() || source[key].trim().length > 120) fail(400, 'invalid_localized_name')
    result[key] = source[key].trim() as string
  }
  if (!result.en) fail(400, 'english_name_required')
  return JSON.stringify(result)
}
function jsonObject(value: unknown, maxBytes = 4000): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_json_object')
  const result = JSON.stringify(value)
  if (new TextEncoder().encode(result).byteLength > maxBytes) fail(400, 'json_object_too_large')
  return result
}
function int(value: unknown, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(400, 'invalid_menu_value')
  return value
}
function bool(value: unknown, fallback: boolean): number {
  if (value === undefined) return Number(fallback)
  if (typeof value !== 'boolean') fail(400, 'invalid_menu_value')
  return Number(value)
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
function parsedRows(rows: Row[], jsonColumns: string[], boolColumns: string[] = []) {
  return rows.map(row => {
    const output: Row = { ...row }
    for (const column of jsonColumns) {
      if (typeof output[column] === 'string') {
        try { output[column] = JSON.parse(output[column] as string) } catch { output[column] = {} }
      }
    }
    for (const column of boolColumns) output[column] = Boolean(output[column])
    return output
  })
}
function requireManager(actor: Actor) {
  if (!['owner','manager'].includes(actor.role)) fail(403, 'restaurant_role_forbidden')
}

export async function loadRestaurantMenu(env: Env, tenantId: string) {
  const [profile,categories,items,variants,groups,addons,links] = await Promise.all([
    env.DB.prepare(`SELECT display_name,currency_code,timezone,default_language,tax_mode,tax_rate,gst_rate,tax_inclusive,accepting_orders,legal_name,gstin,address_line1,address_line2,city,state_name,state_code,postal_code,invoice_prefix FROM restaurant_profiles WHERE tenant_id=?`).bind(tenantId).first<Row>(),
    env.DB.prepare('SELECT * FROM restaurant_menu_categories WHERE tenant_id=? ORDER BY sort_order,id').bind(tenantId).all<Row>(),
    env.DB.prepare('SELECT * FROM restaurant_menu_items WHERE tenant_id=? ORDER BY category_id,sort_order,id').bind(tenantId).all<Row>(),
    env.DB.prepare('SELECT * FROM restaurant_menu_variants WHERE tenant_id=? ORDER BY item_id,sort_order,id').bind(tenantId).all<Row>(),
    env.DB.prepare('SELECT * FROM restaurant_addon_groups WHERE tenant_id=? ORDER BY sort_order,id').bind(tenantId).all<Row>(),
    env.DB.prepare('SELECT * FROM restaurant_addons WHERE tenant_id=? ORDER BY group_id,sort_order,id').bind(tenantId).all<Row>(),
    env.DB.prepare('SELECT * FROM restaurant_item_addon_groups WHERE tenant_id=? ORDER BY item_id,group_id').bind(tenantId).all<Row>(),
  ])
  return {
    restaurant: profile ? { ...profile, tax_inclusive: Boolean(profile.tax_inclusive), accepting_orders: Boolean(profile.accepting_orders) } : null,
    categories: parsedRows(categories.results,['name','schedule'],['active']),
    items: parsedRows(items.results,['name','description','schedule'],['available','stock_tracking','active']),
    variants: parsedRows(variants.results,['name'],['available','active']),
    addon_groups: parsedRows(groups.results,['name'],['required','active']),
    addons: parsedRows(addons.results,['name'],['available','active']),
    item_addon_groups: links.results,
  }
}

function validateCategory(source: Row) {
  const name = localized(source.name)
  const sortOrder = int(source.sort_order,0,100000,0)
  const station = source.station === undefined || source.station === null || source.station === '' ? null : String(source.station).trim()
  if (station !== null && station.length > 80) fail(400, 'invalid_station')
  const schedule = jsonObject(source.schedule ?? {})
  const active = bool(source.active,true)
  return { name, sortOrder, station, schedule, active }
}

function validateItem(source: Row) {
  const categoryId = source.category_id
  if (!uuid(categoryId)) fail(400, 'invalid_category')
  const name = localized(source.name)
  const description = jsonObject(source.description ?? {})
  const basePrice = int(source.base_price_minor,0,1000000000)
  const foodType = source.food_type ?? 'veg'
  if (!['veg','non_veg','egg'].includes(String(foodType))) fail(400, 'invalid_food_type')
  const prepMinutes = int(source.prep_minutes,0,1440,0)
  const priority = int(source.priority,0,100,0)
  const available = bool(source.available,true)
  const stockTracking = bool(source.stock_tracking,false)
  let stockQuantity: number | null = null
  if (source.stock_quantity !== undefined && source.stock_quantity !== null && source.stock_quantity !== '') {
    if (typeof source.stock_quantity !== 'number' || !Number.isFinite(source.stock_quantity) || source.stock_quantity < 0 || Math.round(source.stock_quantity*1000)!==source.stock_quantity*1000) fail(400, 'invalid_stock_quantity')
    stockQuantity = source.stock_quantity
  }
  let lowStockAt: number | null = null
  if (source.low_stock_at !== undefined && source.low_stock_at !== null && source.low_stock_at !== '') {
    if (typeof source.low_stock_at !== 'number' || !Number.isFinite(source.low_stock_at) || source.low_stock_at < 0 || Math.round(source.low_stock_at*1000)!==source.low_stock_at*1000) fail(400, 'invalid_low_stock_threshold')
    lowStockAt = source.low_stock_at
  }
  const schedule = jsonObject(source.schedule ?? {})
  const sortOrder = int(source.sort_order,0,100000,0)
  const active = bool(source.active,true)
  const hsn = source.hsn_sac_code === undefined || source.hsn_sac_code === null || source.hsn_sac_code === '' ? null : String(source.hsn_sac_code).trim()
  if (hsn !== null && !/^\d{4}(?:\d{2})?(?:\d{2})?$/.test(hsn)) fail(400, 'invalid_hsn_sac_code')
  return { categoryId, name, description, basePrice, foodType, prepMinutes, priority, available, stockTracking, stockQuantity, lowStockAt, schedule, sortOrder, active, hsn }
}

async function categoryExists(env: Env, tenantId: string, categoryId: string, activeOnly = true) {
  const row = await env.DB.prepare(activeOnly ? 'SELECT id FROM restaurant_menu_categories WHERE tenant_id=? AND id=? AND active=1' : 'SELECT id FROM restaurant_menu_categories WHERE tenant_id=? AND id=?').bind(tenantId,categoryId).first()
  if (!row) fail(400, 'category_not_found')
}

async function handleCategories(request: Request, env: Env, actor: Actor, parts: string[]) {
  if (parts.length===4 && request.method==='POST') {
    const input=validateCategory(await body(request))
    const result=await env.DB.prepare(
      'INSERT INTO restaurant_menu_categories(tenant_id,name,sort_order,station,schedule,active) VALUES(?,?,?,?,?,?) RETURNING *',
    ).bind(actor.tenantId,input.name,input.sortOrder,input.station,input.schedule,input.active).all<Row>()
    if (!result.results[0]) fail(500,'category_create_failed')
    return json(201,{category:parsedRows(result.results,['name','schedule'],['active'])[0]})
  }
  if (parts.length===5 && request.method==='PATCH') {
    const id=parts[4]
    if(!uuid(id)) fail(404,'category_not_found')
    const current=await env.DB.prepare('SELECT * FROM restaurant_menu_categories WHERE tenant_id=? AND id=?').bind(actor.tenantId,id).first<Row>()
    if(!current) fail(404,'category_not_found')
    const patch=await body(request)
    const allowed=new Set(['name','sort_order','station','schedule','active'])
    if(!Object.keys(patch).length||Object.keys(patch).some(key=>!allowed.has(key))) fail(400,'empty_update')
    const merged:Row={name:patch.name??JSON.parse(String(current.name)),sort_order:patch.sort_order??current.sort_order,station:patch.station??current.station,schedule:patch.schedule??JSON.parse(String(current.schedule)),active:patch.active??Boolean(current.active)}
    const input=validateCategory(merged)
    const result=await env.DB.prepare(
      'UPDATE restaurant_menu_categories SET name=?,sort_order=?,station=?,schedule=?,active=? WHERE tenant_id=? AND id=? RETURNING *',
    ).bind(input.name,input.sortOrder,input.station,input.schedule,input.active,actor.tenantId,id).all<Row>()
    return json(200,{category:parsedRows(result.results,['name','schedule'],['active'])[0]})
  }
  return json(404,{error:'menu_route_not_found'})
}

async function handleItems(request: Request, env: Env, actor: Actor, parts: string[]) {
  if(parts.length===4 && request.method==='POST'){
    const input=validateItem(await body(request))
    await categoryExists(env,actor.tenantId,input.categoryId,true)
    const result=await env.DB.prepare(
      `INSERT INTO restaurant_menu_items
       (tenant_id,category_id,name,description,base_price_minor,food_type,prep_minutes,priority,available,stock_tracking,stock_quantity,low_stock_at,schedule,sort_order,active,hsn_sac_code)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    ).bind(actor.tenantId,input.categoryId,input.name,input.description,input.basePrice,input.foodType,input.prepMinutes,input.priority,input.available,input.stockTracking,input.stockQuantity,input.lowStockAt,input.schedule,input.sortOrder,input.active,input.hsn).all<Row>()
    if(!result.results[0]) fail(500,'menu_item_create_failed')
    return json(201,{item:parsedRows(result.results,['name','description','schedule'],['available','stock_tracking','active'])[0]})
  }
  if(parts.length===5 && request.method==='PATCH'){
    const id=parts[4]
    if(!uuid(id)) fail(404,'menu_item_not_found')
    const current=await env.DB.prepare('SELECT * FROM restaurant_menu_items WHERE tenant_id=? AND id=?').bind(actor.tenantId,id).first<Row>()
    if(!current) fail(404,'menu_item_not_found')
    const patch=await body(request)
    if('stock_quantity' in patch) fail(400,'stock_adjustment_required')
    const allowed=new Set(['category_id','name','description','base_price_minor','food_type','prep_minutes','priority','available','stock_tracking','sort_order','active','hsn_sac_code'])
    if(!Object.keys(patch).length||Object.keys(patch).some(key=>!allowed.has(key))) fail(400,'empty_update')
    const merged:Row={
      category_id:patch.category_id??current.category_id,
      name:patch.name??JSON.parse(String(current.name)),
      description:patch.description??JSON.parse(String(current.description)),
      base_price_minor:patch.base_price_minor??current.base_price_minor,
      food_type:patch.food_type??current.food_type,
      prep_minutes:patch.prep_minutes??current.prep_minutes,
      priority:patch.priority??current.priority,
      available:patch.available??Boolean(current.available),
      stock_tracking:patch.stock_tracking??Boolean(current.stock_tracking),
      stock_quantity:current.stock_quantity,
      low_stock_at:patch.low_stock_at??current.low_stock_at,
      schedule:patch.schedule??JSON.parse(String(current.schedule)),
      sort_order:patch.sort_order??current.sort_order,
      active:patch.active??Boolean(current.active),
      hsn_sac_code:patch.hsn_sac_code??current.hsn_sac_code,
    }
    const input=validateItem(merged)
    if(patch.category_id!==undefined) await categoryExists(env,actor.tenantId,input.categoryId,true)
    const result=await env.DB.prepare(
      `UPDATE restaurant_menu_items SET category_id=?,name=?,description=?,base_price_minor=?,food_type=?,prep_minutes=?,priority=?,available=?,stock_tracking=?,low_stock_at=?,schedule=?,sort_order=?,active=?,hsn_sac_code=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE tenant_id=? AND id=? RETURNING *`,
    ).bind(input.categoryId,input.name,input.description,input.basePrice,input.foodType,input.prepMinutes,input.priority,input.available,input.stockTracking,input.lowStockAt,input.schedule,input.sortOrder,input.active,input.hsn,actor.tenantId,id).all<Row>()
    return json(200,{item:parsedRows(result.results,['name','description','schedule'],['available','stock_tracking','active'])[0]})
  }
  if(parts.length===6 && parts[5]==='stock-adjustments'){
    const id=parts[4]
    if(!uuid(id)) fail(404,'menu_item_not_found')
    const item=await env.DB.prepare('SELECT id,stock_tracking,stock_quantity FROM restaurant_menu_items WHERE tenant_id=? AND id=?').bind(actor.tenantId,id).first<Row>()
    if(!item) fail(404,'menu_item_not_found')
    if(request.method==='GET'){
      const events=await env.DB.prepare('SELECT id,quantity_delta,old_quantity,new_quantity,reason,created_at FROM restaurant_stock_events WHERE tenant_id=? AND item_id=? ORDER BY created_at DESC,id DESC LIMIT 30').bind(actor.tenantId,id).all<Row>()
      return json(200,{events:events.results})
    }
    if(request.method==='POST'){
      const input=await body(request)
      const delta=input.quantity_delta
      const reason=typeof input.reason==='string'?input.reason.trim():''
      if(typeof delta!=='number'||!Number.isFinite(delta)||delta===0||Math.abs(delta)>1000000||Math.round(delta*1000)!==delta*1000||!reason||reason.length>120) fail(400,'invalid_stock_adjustment')
      if(!Number(item.stock_tracking)||item.stock_quantity===null) fail(409,'stock_tracking_not_configured')
      const oldQuantity=Number(item.stock_quantity)
      const newQuantity=Math.round((oldQuantity+delta)*1000)/1000
      if(newQuantity<0) fail(409,'insufficient_stock')
      const eventId=crypto.randomUUID()
      const updatedAt=new Date().toISOString()
      const results=await env.DB.batch([
        env.DB.prepare(`UPDATE restaurant_menu_items SET stock_quantity=?,last_stock_adjustment_id=?,updated_at=? WHERE tenant_id=? AND id=? AND stock_tracking=1 AND stock_quantity=?`).bind(newQuantity,eventId,updatedAt,actor.tenantId,id,oldQuantity),
        env.DB.prepare(`INSERT INTO restaurant_stock_events(id,tenant_id,item_id,quantity_delta,old_quantity,new_quantity,reason,changed_by)
          SELECT ?,?,?,?,?,?,?,? FROM restaurant_menu_items WHERE tenant_id=? AND id=? AND last_stock_adjustment_id=? AND stock_quantity=?`).bind(eventId,actor.tenantId,id,delta,oldQuantity,newQuantity,reason,actor.staffId,actor.tenantId,id,eventId,newQuantity),
      ])
      if(Number(results[0]?.meta?.changes)!==1) fail(409,'stock_changed_retry')
      if(Number(results[1]?.meta?.changes)!==1) fail(500,'stock_adjustment_log_failed')
      return json(200,{stock:{old_quantity:oldQuantity,new_quantity:newQuantity},adjustment_id:eventId})
    }
  }
  if(parts.length===6 && parts[5]==='variants' && request.method==='POST'){
    const itemId=parts[4]
    if(!uuid(itemId)) fail(404,'menu_item_not_found')
    const item=await env.DB.prepare('SELECT id FROM restaurant_menu_items WHERE tenant_id=? AND id=? AND active=1').bind(actor.tenantId,itemId).first()
    if(!item) fail(404,'menu_item_not_found')
    const input=await body(request)
    const name=localized(input.name), price=int(input.price_minor,0,1000000000), sortOrder=int(input.sort_order,0,100000,0), available=bool(input.available,true), active=bool(input.active,true)
    const result=await env.DB.prepare('INSERT INTO restaurant_menu_variants(tenant_id,item_id,name,price_minor,available,sort_order,active) VALUES(?,?,?,?,?,?,?) RETURNING *').bind(actor.tenantId,itemId,name,price,available,sortOrder,active).all<Row>()
    return json(201,{variant:parsedRows(result.results,['name'],['available','active'])[0]})
  }
  return json(404,{error:'menu_route_not_found'})
}

async function handleVariant(request: Request, env: Env, actor: Actor, id: string) {
  if(request.method!=='PATCH'||!uuid(id)) return json(404,{error:'menu_variant_not_found'})
  const current=await env.DB.prepare('SELECT * FROM restaurant_menu_variants WHERE tenant_id=? AND id=?').bind(actor.tenantId,id).first<Row>()
  if(!current) fail(404,'menu_variant_not_found')
  const patch=await body(request)
  const allowed=new Set(['name','price_minor','available','active','sort_order'])
  if(!Object.keys(patch).length||Object.keys(patch).some(key=>!allowed.has(key))) fail(400,'empty_update')
  const name=patch.name===undefined?String(current.name):localized(patch.name)
  const price=patch.price_minor===undefined?Number(current.price_minor):int(patch.price_minor,0,1000000000)
  const available=patch.available===undefined?Number(current.available):bool(patch.available,true)
  const active=patch.active===undefined?Number(current.active):bool(patch.active,true)
  const sortOrder=patch.sort_order===undefined?Number(current.sort_order):int(patch.sort_order,0,100000)
  const result=await env.DB.prepare('UPDATE restaurant_menu_variants SET name=?,price_minor=?,available=?,active=?,sort_order=? WHERE tenant_id=? AND id=? RETURNING *').bind(name,price,available,active,sortOrder,actor.tenantId,id).all<Row>()
  return json(200,{variant:parsedRows(result.results,['name'],['available','active'])[0]})
}

async function handleAddonGroups(request: Request, env: Env, actor: Actor, parts: string[]) {
  if(parts.length===4&&request.method==='POST'){
    const input=await body(request)
    const name=localized(input.name), required=bool(input.required,false), minPick=int(input.min_pick,0,20,0), maxPick=int(input.max_pick,minPick,20,Math.max(minPick,1)), active=bool(input.active,true), sortOrder=int(input.sort_order,0,100000,0)
    const result=await env.DB.prepare('INSERT INTO restaurant_addon_groups(tenant_id,name,required,min_pick,max_pick,active,sort_order) VALUES(?,?,?,?,?,?,?) RETURNING *').bind(actor.tenantId,name,required,minPick,maxPick,active,sortOrder).all<Row>()
    return json(201,{addon_group:parsedRows(result.results,['name'],['required','active'])[0]})
  }
  if(parts.length===5&&request.method==='PATCH'){
    const id=parts[4]
    if(!uuid(id)) fail(404,'addon_group_not_found')
    const current=await env.DB.prepare('SELECT * FROM restaurant_addon_groups WHERE tenant_id=? AND id=?').bind(actor.tenantId,id).first<Row>()
    if(!current) fail(404,'addon_group_not_found')
    const patch=await body(request)
    const allowed=new Set(['name','required','min_pick','max_pick','active','sort_order'])
    if(!Object.keys(patch).length||Object.keys(patch).some(key=>!allowed.has(key))) fail(400,'empty_update')
    const name=patch.name===undefined?String(current.name):localized(patch.name)
    const required=patch.required===undefined?Number(current.required):bool(patch.required,false)
    const minPick=patch.min_pick===undefined?Number(current.min_pick):int(patch.min_pick,0,20)
    const maxPick=patch.max_pick===undefined?Number(current.max_pick):int(patch.max_pick,minPick,20)
    if(maxPick<minPick) fail(400,'invalid_pick_limits')
    const active=patch.active===undefined?Number(current.active):bool(patch.active,true)
    const sortOrder=patch.sort_order===undefined?Number(current.sort_order):int(patch.sort_order,0,100000)
    const result=await env.DB.prepare('UPDATE restaurant_addon_groups SET name=?,required=?,min_pick=?,max_pick=?,active=?,sort_order=? WHERE tenant_id=? AND id=? RETURNING *').bind(name,required,minPick,maxPick,active,sortOrder,actor.tenantId,id).all<Row>()
    return json(200,{addon_group:parsedRows(result.results,['name'],['required','active'])[0]})
  }
  if(parts.length===6&&parts[5]==='addons'&&request.method==='POST'){
    const groupId=parts[4]
    if(!uuid(groupId)) fail(404,'addon_group_not_found')
    const group=await env.DB.prepare('SELECT id FROM restaurant_addon_groups WHERE tenant_id=? AND id=? AND active=1').bind(actor.tenantId,groupId).first()
    if(!group) fail(404,'addon_group_not_found')
    const input=await body(request)
    const name=localized(input.name), price=int(input.price_minor,0,1000000000,0), available=bool(input.available,true), active=bool(input.active,true), sortOrder=int(input.sort_order,0,100000,0)
    const result=await env.DB.prepare('INSERT INTO restaurant_addons(tenant_id,group_id,name,price_minor,available,active,sort_order) VALUES(?,?,?,?,?,?,?) RETURNING *').bind(actor.tenantId,groupId,name,price,available,active,sortOrder).all<Row>()
    return json(201,{addon:parsedRows(result.results,['name'],['available','active'])[0]})
  }
  return json(404,{error:'menu_route_not_found'})
}

async function handleAddon(request: Request, env: Env, actor: Actor, id: string) {
  if(request.method!=='PATCH'||!uuid(id)) return json(404,{error:'menu_addon_not_found'})
  const current=await env.DB.prepare('SELECT * FROM restaurant_addons WHERE tenant_id=? AND id=?').bind(actor.tenantId,id).first<Row>()
  if(!current) fail(404,'menu_addon_not_found')
  const patch=await body(request)
  const allowed=new Set(['name','price_minor','available','active','sort_order'])
  if(!Object.keys(patch).length||Object.keys(patch).some(key=>!allowed.has(key))) fail(400,'empty_update')
  const name=patch.name===undefined?String(current.name):localized(patch.name)
  const price=patch.price_minor===undefined?Number(current.price_minor):int(patch.price_minor,0,1000000000)
  const available=patch.available===undefined?Number(current.available):bool(patch.available,true)
  const active=patch.active===undefined?Number(current.active):bool(patch.active,true)
  const sortOrder=patch.sort_order===undefined?Number(current.sort_order):int(patch.sort_order,0,100000)
  const result=await env.DB.prepare('UPDATE restaurant_addons SET name=?,price_minor=?,available=?,active=?,sort_order=? WHERE tenant_id=? AND id=? RETURNING *').bind(name,price,available,active,sortOrder,actor.tenantId,id).all<Row>()
  return json(200,{addon:parsedRows(result.results,['name'],['available','active'])[0]})
}

async function handleItemAddonGroup(request: Request, env: Env, actor: Actor, parts: string[]) {
  if(parts.length===6&&parts[5]==='addon-groups'&&request.method==='POST'){
    const itemId=parts[4]
    if(!uuid(itemId)) fail(404,'menu_item_not_found')
    const input=await body(request)
    if(!uuid(input.group_id)) fail(400,'invalid_addon_group')
    const [item,group]=await Promise.all([
      env.DB.prepare('SELECT id FROM restaurant_menu_items WHERE tenant_id=? AND id=? AND active=1').bind(actor.tenantId,itemId).first(),
      env.DB.prepare('SELECT id FROM restaurant_addon_groups WHERE tenant_id=? AND id=? AND active=1').bind(actor.tenantId,input.group_id).first(),
    ])
    if(!item||!group) fail(404,'menu_item_or_addon_group_not_found')
    await env.DB.prepare('INSERT INTO restaurant_item_addon_groups(tenant_id,item_id,group_id) VALUES(?,?,?) ON CONFLICT(tenant_id,item_id,group_id) DO NOTHING').bind(actor.tenantId,itemId,input.group_id).run()
    return json(201,{linked:true})
  }
  if(parts.length===7&&parts[5]==='addon-groups'&&request.method==='DELETE'){
    const itemId=parts[4],groupId=parts[6]
    if(!uuid(itemId)||!uuid(groupId)) fail(404,'menu_item_or_addon_group_not_found')
    const result=await env.DB.prepare('DELETE FROM restaurant_item_addon_groups WHERE tenant_id=? AND item_id=? AND group_id=?').bind(actor.tenantId,itemId,groupId).run()
    if(Number(result.meta.changes)!==1) fail(404,'menu_item_addon_group_not_found')
    return json(200,{linked:false})
  }
  return json(404,{error:'menu_route_not_found'})
}

export async function handleRestaurantMenuRoutes(request: Request, env: Env, actor: Actor, parts: string[]): Promise<Response> {
  requireManager(actor)
  try {
    if(parts.length===3&&parts[2]==='menu'&&request.method==='GET') return json(200,await loadRestaurantMenu(env,actor.tenantId))
    if(parts[2]==='menu'&&parts[3]==='categories') return await handleCategories(request,env,actor,parts)
    if(parts[2]==='menu'&&parts[3]==='items'&&(parts[5]==='photo-upload'||parts[5]==='photo-complete')) return json(503,{error:'object_storage_not_configured'})
    if(parts[2]==='menu'&&parts[3]==='items'&&parts[5]==='addon-groups') return await handleItemAddonGroup(request,env,actor,parts)
    if(parts[2]==='menu'&&parts[3]==='items') return await handleItems(request,env,actor,parts)
    if(parts[2]==='menu'&&parts[3]==='variants'&&parts.length===5) return await handleVariant(request,env,actor,parts[4])
    if(parts[2]==='menu'&&parts[3]==='addon-groups') return await handleAddonGroups(request,env,actor,parts)
    if(parts[2]==='menu'&&parts[3]==='addons'&&parts.length===5) return await handleAddon(request,env,actor,parts[4])
    return json(404,{error:'menu_route_not_found'})
  } catch(error) { return errorResponse(error) }
}
