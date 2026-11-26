import { withTenantTransaction } from '../db/pool.mjs'
import { createPresignedObjectUrl, createRestaurantObjectKey } from '../storage/object-storage.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function fail(statusCode, code) {
  const error = new Error(code)
  error.statusCode = statusCode
  throw error
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 8192) fail(413, 'payload_too_large')
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request')
    return body
  } catch (error) {
    if (error.statusCode) throw error
    fail(400, 'invalid_request')
  }
}

function localizedName(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length > 0 && keys.every(key => ['en', 'hi', 'kn', 'ta', 'te', 'ml'].includes(key)) &&
    keys.every(key => typeof value[key] === 'string' && value[key].trim().length > 0 && value[key].length <= 120)
}

function validateItem(body) {
  if (!UUID.test(body.category_id || '') || !localizedName(body.name)) fail(400, 'invalid_menu_item')
  if (body.description !== undefined && (!body.description || typeof body.description !== 'object' || Array.isArray(body.description))) {
    fail(400, 'invalid_menu_item')
  }
  if (!Number.isSafeInteger(body.base_price_minor) || body.base_price_minor < 0) fail(400, 'invalid_menu_item')
  if (!['veg', 'non_veg', 'egg'].includes(body.food_type ?? 'veg')) fail(400, 'invalid_menu_item')
  if (body.available !== undefined && typeof body.available !== 'boolean') fail(400, 'invalid_menu_item')
  if (!Number.isInteger(body.sort_order ?? 0) || (body.sort_order ?? 0) < 0 || (body.sort_order ?? 0) > 100000) fail(400, 'invalid_menu_item')
  if (body.stock_tracking !== undefined && typeof body.stock_tracking !== 'boolean') fail(400, 'invalid_menu_item')
  if (!Number.isInteger(body.prep_minutes ?? 0) || (body.prep_minutes ?? 0) < 0 || (body.prep_minutes ?? 0) > 1440) fail(400, 'invalid_menu_item')
  if (!Number.isInteger(body.priority ?? 0) || (body.priority ?? 0) < 0 || (body.priority ?? 0) > 100) fail(400, 'invalid_menu_item')
  if (body.stock_tracking !== undefined && typeof body.stock_tracking !== 'boolean') fail(400, 'invalid_menu_item')
  if (body.stock_quantity !== undefined && body.stock_quantity !== null &&
      (typeof body.stock_quantity !== 'number' || !Number.isFinite(body.stock_quantity) || body.stock_quantity < 0)) fail(400, 'invalid_menu_item')
  if (body.hsn_sac_code !== undefined && body.hsn_sac_code !== null && body.hsn_sac_code !== '' &&
      (typeof body.hsn_sac_code !== 'string' || !/^(?:\d{4}|\d{6}|\d{8})$/.test(body.hsn_sac_code))) fail(400, 'invalid_hsn_sac_code')
}

export async function handleOwnerMenuRoutes(request, response, { database, tenantId, actor, parts, objectStorage = null }) {
  try {
    if (!['owner', 'manager'].includes(actor.role)) fail(403, 'restaurant_role_forbidden')


    if (parts[2] === 'menu' && parts[3] === 'items' && parts.length === 6 &&
        ['photo-upload', 'photo-complete'].includes(parts[5]) && request.method === 'POST') {
      if (!objectStorage) fail(503, 'object_storage_not_configured')
      const itemId = parts[4]
      if (!UUID.test(itemId)) fail(404, 'menu_item_not_found')
      const body = await readBody(request)
      const mimeToExtension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' }
      const extension = mimeToExtension[body.content_type]
      if (!extension) fail(400, 'unsupported_image_type')
      const key = createRestaurantObjectKey(tenantId, itemId, extension)
      const exists = await withTenantTransaction(database, tenantId, client => client.query(
        'SELECT id FROM restaurant_menu_items WHERE tenant_id=$1 AND id=$2 AND active=true',
        [tenantId, itemId],
      ))
      if (!exists.rows[0]) fail(404, 'menu_item_not_found')

      if (parts[5] === 'photo-upload') {
        const uploadUrl = createPresignedObjectUrl(objectStorage, {
          method: 'PUT', key, contentType: body.content_type, expiresSeconds: 300,
        })
        send(response, 200, { upload_url: uploadUrl, object_key: key,
          required_headers: { 'Content-Type': body.content_type }, expires_in_seconds: 300 })
        return true
      }

      const checkUrl = createPresignedObjectUrl(objectStorage, { method: 'HEAD', key, expiresSeconds: 60 })
      const check = await fetch(checkUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
      if (!check.ok) fail(check.status === 404 ? 409 : 502, check.status === 404 ? 'photo_upload_not_found' : 'photo_storage_unavailable')
      const updated = await withTenantTransaction(database, tenantId, client => client.query(
        'UPDATE restaurant_menu_items SET photo_object_key=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,photo_object_key',
        [tenantId, itemId, key],
      ))
      if (!updated.rows[0]) fail(404, 'menu_item_not_found')
      send(response, 200, { item: updated.rows[0] })
      return true
    }

    if (parts[2] === 'menu' && parts.length === 3 && request.method === 'GET') {
      const result = await withTenantTransaction(database, tenantId, async client => {
        const categories = await client.query(
          `SELECT id, name, sort_order, station, schedule, active
           FROM restaurant_menu_categories WHERE tenant_id=$1
           ORDER BY sort_order, id`,
          [tenantId],
        )
        const items = await client.query(
          `SELECT id, category_id, name, description, base_price_minor, food_type,
             photo_object_key, prep_minutes, priority, available, stock_tracking,
             stock_quantity, low_stock_at, hsn_sac_code, sort_order, active
           FROM restaurant_menu_items WHERE tenant_id=$1
           ORDER BY category_id, sort_order, priority DESC, id`,
          [tenantId],
        )
        const variants = await client.query(
          `SELECT id,item_id,name,price_minor,available,sort_order,active
           FROM restaurant_menu_variants WHERE tenant_id=$1 ORDER BY item_id,sort_order,id`,
          [tenantId],
        )
        const addonGroups = await client.query(
          `SELECT id,name,required,min_pick,max_pick,active,sort_order
           FROM restaurant_addon_groups WHERE tenant_id=$1 ORDER BY sort_order,id`,
          [tenantId],
        )
        const addons = await client.query(
          `SELECT id,group_id,name,price_minor,available,active,sort_order
           FROM restaurant_addons WHERE tenant_id=$1 ORDER BY group_id,sort_order,id`,
          [tenantId],
        )
        const itemAddonGroups = await client.query(
          `SELECT item_id,group_id FROM restaurant_item_addon_groups WHERE tenant_id=$1 ORDER BY item_id,group_id`,
          [tenantId],
        )
        return { categories: categories.rows, items: items.rows, variants: variants.rows,
          addon_groups: addonGroups.rows, addons: addons.rows, item_addon_groups: itemAddonGroups.rows }
      })
      send(response, 200, result)
      return true
    }

    if (parts[2] === 'menu' && parts[3] === 'categories' && parts.length === 4 && request.method === 'POST') {
      const body = await readBody(request)
      if (!localizedName(body.name)) fail(400, 'invalid_menu_category')
      const sortOrder = body.sort_order ?? 0
      if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) fail(400, 'invalid_menu_category')
      const station = typeof body.station === 'string' ? body.station.trim().slice(0, 80) : null
      const result = await withTenantTransaction(database, tenantId, client => client.query(
        `INSERT INTO restaurant_menu_categories(tenant_id,name,sort_order,station)
         VALUES ($1,$2::jsonb,$3,$4) RETURNING id,name,sort_order,station,active`,
        [tenantId, JSON.stringify(body.name), sortOrder, station || null],
      ))
      send(response, 201, { category: result.rows[0] })
      return true
    }

    if (parts[2] === 'menu' && parts[3] === 'categories' && parts.length === 5 && request.method === 'PATCH') {
      const id = parts[4]
      if (!UUID.test(id)) fail(404, 'menu_category_not_found')
      const body = await readBody(request)
      const sets = []
      const values = [tenantId, id]
      if (body.name !== undefined) {
        if (!localizedName(body.name)) fail(400, 'invalid_menu_category')
        values.push(JSON.stringify(body.name)); sets.push(`name=$${values.length}::jsonb`)
      }
      if (body.sort_order !== undefined) {
        if (!Number.isInteger(body.sort_order) || body.sort_order < 0 || body.sort_order > 100000) fail(400, 'invalid_menu_category')
        values.push(body.sort_order); sets.push(`sort_order=$${values.length}`)
      }
      if (body.station !== undefined) {
        if (body.station !== null && typeof body.station !== 'string') fail(400, 'invalid_menu_category')
        values.push(typeof body.station === 'string' ? body.station.trim().slice(0, 80) || null : null)
        sets.push(`station=$${values.length}`)
      }
      if (body.active !== undefined) {
        if (typeof body.active !== 'boolean') fail(400, 'invalid_menu_category')
        values.push(body.active); sets.push(`active=$${values.length}`)
      }
      if (!sets.length) fail(400, 'empty_update')
      const result = await withTenantTransaction(database, tenantId, client => client.query(
        `UPDATE restaurant_menu_categories SET ${sets.join(', ')}
         WHERE tenant_id=$1 AND id=$2 RETURNING id,name,sort_order,station,active`,
        values,
      ))
      if (!result.rows[0]) fail(404, 'menu_category_not_found')
      send(response, 200, { category: result.rows[0] })
      return true
    }

    if (parts[2] === 'menu' && parts[3] === 'items' && parts.length === 4 && request.method === 'POST') {
      const body = await readBody(request)
      validateItem(body)
      const result = await withTenantTransaction(database, tenantId, async client => {
        const category = await client.query(
          'SELECT id FROM restaurant_menu_categories WHERE tenant_id=$1 AND id=$2 AND active=true',
          [tenantId, body.category_id],
        )
        if (!category.rows[0]) fail(400, 'menu_category_not_found')
        return client.query(
          `INSERT INTO restaurant_menu_items
           (tenant_id,category_id,name,description,base_price_minor,food_type,prep_minutes,priority,available,stock_tracking,stock_quantity,hsn_sac_code,sort_order)
           VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING id,category_id,name,description,base_price_minor,food_type,prep_minutes,priority,available,stock_tracking,stock_quantity,hsn_sac_code,sort_order,active`,
          [tenantId, body.category_id, JSON.stringify(body.name), JSON.stringify(body.description ?? {}),
            body.base_price_minor, body.food_type ?? 'veg', body.prep_minutes ?? 0, body.priority ?? 0,
            body.available ?? true, body.stock_tracking ?? false, body.stock_quantity ?? null, body.hsn_sac_code || null, body.sort_order ?? 0],
        )
      })
      send(response, 201, { item: result.rows[0] })
      return true
    }

    if (parts[2] === 'menu' && parts[3] === 'items' && parts.length === 5 && request.method === 'PATCH') {
      const id = parts[4]
      if (!UUID.test(id)) fail(404, 'menu_item_not_found')
      const body = await readBody(request)
      // Stock quantity changes must go through the audited stock-adjustments endpoint.
      if (Object.hasOwn(body, 'stock_quantity')) fail(400, 'stock_adjustment_required')
      const allowed = ['category_id','name','description','base_price_minor','food_type','prep_minutes','priority','available','stock_tracking','sort_order','active','hsn_sac_code']
      if (!Object.keys(body).some(key => allowed.includes(key))) fail(400, 'empty_update')
      const current = await withTenantTransaction(database, tenantId, async client => {
        const found = await client.query(
          'SELECT id,category_id,name,description,base_price_minor,food_type,prep_minutes,priority,available,stock_tracking,stock_quantity,hsn_sac_code,sort_order,active FROM restaurant_menu_items WHERE tenant_id=$1 AND id=$2',
          [tenantId, id],
        )
        if (!found.rows[0]) fail(404, 'menu_item_not_found')
        return found.rows[0]
      })
      const merged = { ...current, ...body }
      merged.base_price_minor = Number(merged.base_price_minor)
      merged.stock_quantity = merged.stock_quantity === null ? null : Number(merged.stock_quantity)
      merged.category_id = body.category_id ?? current.category_id
      validateItem(merged)
      if (body.available !== undefined && typeof body.available !== 'boolean') fail(400, 'invalid_menu_item')
      if (body.active !== undefined && typeof body.active !== 'boolean') fail(400, 'invalid_menu_item')
      if (body.sort_order !== undefined && (!Number.isInteger(body.sort_order) || body.sort_order < 0 || body.sort_order > 100000)) fail(400, 'invalid_menu_item')
      const result = await withTenantTransaction(database, tenantId, async client => {
        if (body.category_id !== undefined) {
          const category = await client.query('SELECT id FROM restaurant_menu_categories WHERE tenant_id=$1 AND id=$2 AND active=true', [tenantId, body.category_id])
          if (!category.rows[0]) fail(400, 'menu_category_not_found')
        }
        return client.query(
          `UPDATE restaurant_menu_items SET
             category_id=$3,name=$4::jsonb,description=$5::jsonb,base_price_minor=$6,food_type=$7,
             prep_minutes=$8,priority=$9,available=$10,stock_tracking=$11,stock_quantity=$12,
             hsn_sac_code=$13,sort_order=$14,active=$15,updated_at=now()
           WHERE tenant_id=$1 AND id=$2
           RETURNING id,category_id,name,description,base_price_minor,food_type,prep_minutes,priority,available,stock_tracking,stock_quantity,hsn_sac_code,sort_order,active`,
          [tenantId,id,merged.category_id,JSON.stringify(merged.name),JSON.stringify(merged.description ?? {}),
            merged.base_price_minor,merged.food_type,merged.prep_minutes,merged.priority,merged.available,
            merged.stock_tracking,merged.stock_quantity,merged.hsn_sac_code || null,merged.sort_order,merged.active],
        )
      })
      send(response, 200, { item: result.rows[0] })
      return true
    }


    if (parts[2] === 'menu' && parts[3] === 'items' && parts.length === 6 && parts[5] === 'stock-adjustments' && ['GET','POST'].includes(request.method)) {
      const itemId = parts[4]
      if (!UUID.test(itemId)) fail(404, 'menu_item_not_found')
      if (request.method === 'GET') {
        const events = await withTenantTransaction(database, tenantId, client => client.query(
          `SELECT id,quantity_delta,old_quantity,new_quantity,reason,created_at
           FROM restaurant_stock_events WHERE tenant_id=$1 AND item_id=$2
           ORDER BY created_at DESC,id DESC LIMIT 30`,
          [tenantId,itemId],
        ))
        send(response,200,{events:events.rows})
        return true
      }
      const body = await readBody(request)
      const delta = Number(body.quantity_delta)
      const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
      if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1000000 ||
          !Number.isInteger(delta * 1000) || !reason || reason.length > 120) fail(400,'invalid_stock_adjustment')
      const result = await withTenantTransaction(database,tenantId,async client => {
        const current = await client.query(
          'SELECT id,stock_tracking,stock_quantity FROM restaurant_menu_items WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [tenantId,itemId],
        )
        const item = current.rows[0]
        if (!item) fail(404,'menu_item_not_found')
        if (!item.stock_tracking || item.stock_quantity === null) fail(409,'stock_tracking_not_configured')
        const oldQuantity = Number(item.stock_quantity)
        const nextQuantity = Number((oldQuantity + delta).toFixed(3))
        if (nextQuantity < 0) fail(409,'insufficient_stock')
        const updated = await client.query(
          `UPDATE restaurant_menu_items SET stock_quantity=$3,updated_at=now()
           WHERE tenant_id=$1 AND id=$2 RETURNING stock_quantity`,
          [tenantId,itemId,nextQuantity],
        )
        await client.query(
          `INSERT INTO restaurant_stock_events(tenant_id,item_id,quantity_delta,old_quantity,new_quantity,reason,changed_by)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId,itemId,delta,oldQuantity,updated.rows[0].stock_quantity,reason,actor.staffId ?? null],
        )
        return {old_quantity:oldQuantity,new_quantity:updated.rows[0].stock_quantity}
      })
      send(response,200,{stock:result})
      return true
    }

    if (parts[2] === 'menu' && parts[3] === 'items' && parts.length === 6 && parts[5] === 'variants' && request.method === 'POST') {
      const itemId = parts[4]
      if (!UUID.test(itemId)) fail(404, 'menu_item_not_found')
      const body = await readBody(request)
      if (!localizedName(body.name) || !Number.isSafeInteger(body.price_minor) || body.price_minor < 0 ||
          !Number.isInteger(body.sort_order ?? 0) || (body.sort_order ?? 0) < 0) fail(400, 'invalid_menu_variant')
      const result = await withTenantTransaction(database, tenantId, async client => {
        const item = await client.query('SELECT id FROM restaurant_menu_items WHERE tenant_id=$1 AND id=$2 AND active=true', [tenantId,itemId])
        if (!item.rows[0]) fail(404, 'menu_item_not_found')
        return client.query(
          `INSERT INTO restaurant_menu_variants(tenant_id,item_id,name,price_minor,available,sort_order)
           VALUES($1,$2,$3::jsonb,$4,$5,$6)
           RETURNING id,item_id,name,price_minor,available,sort_order,active`,
          [tenantId,itemId,JSON.stringify(body.name),body.price_minor,body.available ?? true,body.sort_order ?? 0],
        )
      })
      send(response,201,{variant:result.rows[0]})
      return true
    }

    if (parts[2] === 'menu' && parts[3] === 'variants' && parts.length === 5 && request.method === 'PATCH') {
      const id = parts[4]
      if (!UUID.test(id)) fail(404, 'menu_variant_not_found')
      const body = await readBody(request)
      if (body.name !== undefined && !localizedName(body.name)) fail(400, 'invalid_menu_variant')
      if (body.price_minor !== undefined && (!Number.isSafeInteger(body.price_minor) || body.price_minor < 0)) fail(400, 'invalid_menu_variant')
      for (const key of ['available', 'active']) if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(400, 'invalid_menu_variant')
      if (body.sort_order !== undefined && (!Number.isInteger(body.sort_order) || body.sort_order < 0)) fail(400, 'invalid_menu_variant')
      if (!Object.keys(body).some(key => ['name','price_minor','available','active','sort_order'].includes(key))) fail(400, 'empty_update')
      const result = await withTenantTransaction(database, tenantId, client => client.query(
        `UPDATE restaurant_menu_variants SET name=COALESCE($3::jsonb,name), price_minor=COALESCE($4,price_minor),
           available=COALESCE($5,available), active=COALESCE($6,active), sort_order=COALESCE($7,sort_order)
         WHERE tenant_id=$1 AND id=$2 RETURNING id,item_id,name,price_minor,available,sort_order,active`,
        [tenantId,id,body.name === undefined ? null : JSON.stringify(body.name),body.price_minor ?? null,
          body.available ?? null,body.active ?? null,body.sort_order ?? null],
      ))
      if (!result.rows[0]) fail(404, 'menu_variant_not_found')
      send(response, 200, { variant: result.rows[0] })
      return true
    }

    if (parts[2] === 'menu' && parts[3] === 'addon-groups' && parts.length === 4 && request.method === 'POST') {
      const body = await readBody(request)
      const minPick = body.min_pick ?? 0; const maxPick = body.max_pick ?? 1
      if (!localizedName(body.name) || !Number.isInteger(minPick) || !Number.isInteger(maxPick) ||
          minPick < 0 || maxPick < minPick || maxPick > 20 ||
          (body.required !== undefined && typeof body.required !== 'boolean') ||
          !Number.isInteger(body.sort_order ?? 0) || (body.sort_order ?? 0) < 0) fail(400,'invalid_addon_group')
      const result = await withTenantTransaction(database,tenantId,client => client.query(
        `INSERT INTO restaurant_addon_groups(tenant_id,name,required,min_pick,max_pick,sort_order)
         VALUES($1,$2::jsonb,$3,$4,$5,$6)
         RETURNING id,name,required,min_pick,max_pick,active,sort_order`,
        [tenantId,JSON.stringify(body.name),body.required ?? false,minPick,maxPick,body.sort_order ?? 0]))
      send(response,201,{addon_group:result.rows[0]})
      return true
    }

    if (parts[2] === 'menu' && parts[3] === 'addon-groups' && parts.length === 5 && request.method === 'PATCH') {
      const id = parts[4]
      if (!UUID.test(id)) fail(404, 'addon_group_not_found')
      const body = await readBody(request)
      if (!Object.keys(body).some(key => ['name','required','min_pick','max_pick','sort_order','active'].includes(key))) fail(400, 'empty_update')
      const result = await withTenantTransaction(database, tenantId, async client => {
        const found = await client.query('SELECT id,name,required,min_pick,max_pick,active,sort_order FROM restaurant_addon_groups WHERE tenant_id=$1 AND id=$2', [tenantId,id])
        if (!found.rows[0]) fail(404, 'addon_group_not_found')
        const next = { ...found.rows[0], ...body }
        if (!localizedName(next.name) || typeof next.required !== 'boolean' || typeof next.active !== 'boolean' ||
            !Number.isInteger(next.min_pick) || !Number.isInteger(next.max_pick) || next.min_pick < 0 ||
            next.max_pick < next.min_pick || next.max_pick > 20 || !Number.isInteger(next.sort_order) || next.sort_order < 0) fail(400, 'invalid_addon_group')
        return client.query(
          `UPDATE restaurant_addon_groups SET name=$3::jsonb,required=$4,min_pick=$5,max_pick=$6,active=$7,sort_order=$8
           WHERE tenant_id=$1 AND id=$2 RETURNING id,name,required,min_pick,max_pick,active,sort_order`,
          [tenantId,id,JSON.stringify(next.name),next.required,next.min_pick,next.max_pick,next.active,next.sort_order],
        )
      })
      send(response, 200, { addon_group: result.rows[0] })
      return true
    }

    if (parts[2] === 'menu' && parts[3] === 'addon-groups' && parts.length === 6 && parts[5] === 'addons' && request.method === 'POST') {
      const groupId=parts[4]; if (!UUID.test(groupId)) fail(404,'addon_group_not_found')
      const body=await readBody(request)
      if (!localizedName(body.name) || !Number.isSafeInteger(body.price_minor ?? 0) || (body.price_minor ?? 0)<0 ||
          !Number.isInteger(body.sort_order ?? 0) || (body.sort_order ?? 0)<0) fail(400,'invalid_addon')
      const result=await withTenantTransaction(database,tenantId,async client=>{
        const group=await client.query('SELECT id FROM restaurant_addon_groups WHERE tenant_id=$1 AND id=$2 AND active=true',[tenantId,groupId])
        if (!group.rows[0]) fail(404,'addon_group_not_found')
        return client.query(
          `INSERT INTO restaurant_addons(tenant_id,group_id,name,price_minor,sort_order)
           VALUES($1,$2,$3::jsonb,$4,$5) RETURNING id,group_id,name,price_minor,available,active,sort_order`,
          [tenantId,groupId,JSON.stringify(body.name),body.price_minor ?? 0,body.sort_order ?? 0])
      })
      send(response,201,{addon:result.rows[0]})
      return true
    }

    if (parts[2] === 'menu' && parts[3] === 'addons' && parts.length === 5 && request.method === 'PATCH') {
      const id = parts[4]
      if (!UUID.test(id)) fail(404, 'addon_not_found')
      const body = await readBody(request)
      if (body.name !== undefined && !localizedName(body.name)) fail(400, 'invalid_addon')
      if (body.price_minor !== undefined && (!Number.isSafeInteger(body.price_minor) || body.price_minor < 0)) fail(400, 'invalid_addon')
      for (const key of ['available','active']) if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(400, 'invalid_addon')
      if (body.sort_order !== undefined && (!Number.isInteger(body.sort_order) || body.sort_order < 0)) fail(400, 'invalid_addon')
      if (!Object.keys(body).some(key => ['name','price_minor','available','active','sort_order'].includes(key))) fail(400, 'empty_update')
      const result = await withTenantTransaction(database, tenantId, client => client.query(
        `UPDATE restaurant_addons SET name=COALESCE($3::jsonb,name),price_minor=COALESCE($4,price_minor),
           available=COALESCE($5,available),active=COALESCE($6,active),sort_order=COALESCE($7,sort_order)
         WHERE tenant_id=$1 AND id=$2 RETURNING id,group_id,name,price_minor,available,active,sort_order`,
        [tenantId,id,body.name === undefined ? null : JSON.stringify(body.name),body.price_minor ?? null,
          body.available ?? null,body.active ?? null,body.sort_order ?? null],
      ))
      if (!result.rows[0]) fail(404, 'addon_not_found')
      send(response, 200, { addon: result.rows[0] })
      return true
    }

    if (parts[2] === 'menu' && parts[3] === 'items' && parts.length === 6 && parts[5] === 'addon-groups' && request.method === 'POST') {
      const itemId=parts[4]; if (!UUID.test(itemId)) fail(404,'menu_item_not_found')
      const body=await readBody(request)
      if (!UUID.test(body.group_id || '')) fail(400,'invalid_addon_group')
      const result=await withTenantTransaction(database,tenantId,async client=>{
        const [item,group]=await Promise.all([
          client.query('SELECT id FROM restaurant_menu_items WHERE tenant_id=$1 AND id=$2 AND active=true',[tenantId,itemId]),
          client.query('SELECT id FROM restaurant_addon_groups WHERE tenant_id=$1 AND id=$2 AND active=true',[tenantId,body.group_id]),
        ])
        if (!item.rows[0]) fail(404,'menu_item_not_found')
        if (!group.rows[0]) fail(404,'addon_group_not_found')
        return client.query(
          `INSERT INTO restaurant_item_addon_groups(tenant_id,item_id,group_id) VALUES($1,$2,$3)
           ON CONFLICT DO NOTHING RETURNING item_id,group_id`,[tenantId,itemId,body.group_id])
      })
      send(response,200,{link:result.rows[0] ?? {item_id:itemId,group_id:body.group_id}})
      return true
    }

    if (parts[2] === 'menu' && parts[3] === 'items' && parts.length === 7 && parts[5] === 'addon-groups' && request.method === 'DELETE') {
      const itemId=parts[4]; const groupId=parts[6]
      if (!UUID.test(itemId) || !UUID.test(groupId)) fail(404,'menu_addon_link_not_found')
      const result=await withTenantTransaction(database,tenantId,client=>client.query(
        'DELETE FROM restaurant_item_addon_groups WHERE tenant_id=$1 AND item_id=$2 AND group_id=$3 RETURNING item_id,group_id',
        [tenantId,itemId,groupId]))
      if (!result.rows[0]) fail(404,'menu_addon_link_not_found')
      send(response,200,{link:result.rows[0]})
      return true
    }

    return false
  } catch (error) {
    const status = error.statusCode || (error.code === '23503' ? 400 : 500)
    send(response, status, { error: error.statusCode ? error.message : status === 400 ? 'invalid_menu_reference' : 'restaurant_menu_operation_failed' })
    return true
  }
}
