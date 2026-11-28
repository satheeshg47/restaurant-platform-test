import type { Env } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export async function hashGuestPin(sessionId: string, pin: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionId + ':' + pin)))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyGuestSessionPin(env: Env, tenantId: string, tableId: string, sessionId: string, pin: unknown) {
  if (!UUID.test(sessionId) || typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    throw Object.assign(new Error('guest_pin_required'), { status: 401 })
  }
  const session = await env.DB.prepare(
    "SELECT id,guest_pin_hash,guest_pin_expires_at,guest_pin_attempts FROM restaurant_table_sessions WHERE tenant_id=? AND table_id=? AND id=? AND status='open' LIMIT 1",
  ).bind(tenantId, tableId, sessionId).first<{id:string;guest_pin_hash:string|null;guest_pin_expires_at:string|null;guest_pin_attempts:number}>()
  if (!session) throw Object.assign(new Error('table_session_not_open'), { status: 409 })
  if (!session.guest_pin_hash || !session.guest_pin_expires_at) throw Object.assign(new Error('guest_pin_not_set'), { status: 409 })
  if (Date.parse(session.guest_pin_expires_at) <= Date.now()) throw Object.assign(new Error('guest_pin_expired'), { status: 410 })
  if (Number(session.guest_pin_attempts) >= 10) throw Object.assign(new Error('guest_pin_locked'), { status: 429 })
  const expected = await hashGuestPin(sessionId, pin)
  if (expected !== session.guest_pin_hash) {
    await env.DB.prepare('UPDATE restaurant_table_sessions SET guest_pin_attempts=MIN(10,guest_pin_attempts+1) WHERE tenant_id=? AND id=? AND status=\'open\'')
      .bind(tenantId, sessionId).run()
    throw Object.assign(new Error('guest_pin_invalid'), { status: 401 })
  }
  return session
}
