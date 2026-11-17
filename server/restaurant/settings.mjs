import { withTenantTransaction } from '../db/pool.mjs'

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
function fail(statusCode, code) {
  const error = new Error(code); error.statusCode = statusCode; throw error
}
async function readBody(request) {
  const chunks = []; let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 8192) fail(413, 'payload_too_large')
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_settings')
    return body
  } catch (error) { if (error.statusCode) throw error; fail(400, 'invalid_settings') }
}

export async function handleRestaurantSettings(request, response, { database, tenantId, actor }) {
  try {
    if (!['owner', 'manager'].includes(actor.role)) fail(403, 'restaurant_role_forbidden')
    if (request.method === 'GET') {
      const result = await withTenantTransaction(database, tenantId, client => client.query(
        `SELECT display_name,currency_code,timezone,default_language,tax_mode,tax_rate,gst_rate,
           tax_inclusive,accepting_orders,legal_name,gstin,address_line1,address_line2,city,state_name,state_code,postal_code,invoice_prefix
         FROM restaurant_profiles WHERE tenant_id=$1`, [tenantId]))
      if (!result.rows[0]) fail(404, 'restaurant_profile_not_configured')
      send(response, 200, { settings: result.rows[0] }); return true
    }
    if (request.method !== 'PATCH') return false
    const body = await readBody(request)
    const allowed = ['display_name','currency_code','timezone','default_language','tax_mode','tax_rate','gst_rate','tax_inclusive','accepting_orders','legal_name','gstin','address_line1','address_line2','city','state_name','state_code','postal_code','invoice_prefix']
    if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'invalid_settings')
    if (body.display_name !== undefined && (typeof body.display_name !== 'string' || !body.display_name.trim() || body.display_name.trim().length > 160)) fail(400, 'invalid_settings')
    for (const key of ['legal_name','address_line1','address_line2','city','state_name','postal_code']) if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > 200)) fail(400, 'invalid_settings')
    if (body.gstin !== undefined && (typeof body.gstin !== 'string' || (body.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(body.gstin)))) fail(400, 'invalid_gstin')
    if (body.state_code !== undefined && (typeof body.state_code !== 'string' || !/^\d{2}$/.test(body.state_code))) fail(400, 'invalid_state_code')
    if (body.invoice_prefix !== undefined && (typeof body.invoice_prefix !== 'string' || !/^[A-Z0-9]{1,3}$/.test(body.invoice_prefix))) fail(400, 'invalid_invoice_prefix')
    if (body.currency_code !== undefined && !['INR'].includes(body.currency_code)) fail(400, 'invalid_settings')
    if (body.timezone !== undefined && !['Asia/Kolkata'].includes(body.timezone)) fail(400, 'invalid_settings')
    if (body.default_language !== undefined && !['en','hi','kn'].includes(body.default_language)) fail(400, 'invalid_settings')
    if (body.tax_mode !== undefined && !['none','single','gst'].includes(body.tax_mode)) fail(400, 'invalid_settings')
    for (const key of ['tax_rate','gst_rate']) if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > 100)) fail(400, 'invalid_settings')
    for (const key of ['tax_inclusive','accepting_orders']) if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(400, 'invalid_settings')
    const columns = { display_name:'display_name', currency_code:'currency_code', timezone:'timezone', default_language:'default_language', tax_mode:'tax_mode', tax_rate:'tax_rate', gst_rate:'gst_rate', tax_inclusive:'tax_inclusive', accepting_orders:'accepting_orders', legal_name:'legal_name', gstin:'gstin', address_line1:'address_line1', address_line2:'address_line2', city:'city', state_name:'state_name', state_code:'state_code', postal_code:'postal_code', invoice_prefix:'invoice_prefix' }
    const values = [tenantId]; const sets = []
    for (const key of allowed) if (Object.hasOwn(body,key)) {
      values.push(key === 'display_name' ? body[key].trim() : body[key])
      sets.push(`${columns[key]}=$${values.length}`)
    }
    const result = await withTenantTransaction(database, tenantId, client => client.query(
      `UPDATE restaurant_profiles SET ${sets.join(', ')},updated_at=now()
       WHERE tenant_id=$1
       RETURNING display_name,currency_code,timezone,default_language,tax_mode,tax_rate,gst_rate,tax_inclusive,accepting_orders,legal_name,gstin,address_line1,address_line2,city,state_name,state_code,postal_code,invoice_prefix`,
      values))
    if (!result.rows[0]) fail(404, 'restaurant_profile_not_configured')
    send(response, 200, { settings: result.rows[0] }); return true
  } catch (error) {
    send(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'restaurant_settings_failed' })
    return true
  }
}
