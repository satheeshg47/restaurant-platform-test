import type { Env } from './types.ts'

type MailMessage = { to: string; subject: string; text: string; html: string }

export async function sendPlatformEmail(env: Env, message: MailMessage): Promise<boolean> {
  if (!env.EMAIL_BRIDGE_URL || !env.EMAIL_BRIDGE_SECRET || env.EMAIL_BRIDGE_SECRET.length < 32) return false
  let endpoint: URL
  try { endpoint = new URL(env.EMAIL_BRIDGE_URL) } catch { return false }
  const pathParts = endpoint.pathname.split('/')
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'script.google.com' || pathParts.length !== 5 || pathParts[1] !== 'macros' || pathParts[2] !== 's' || !pathParts[3] || pathParts[4] !== 'exec') return false
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to) || message.to.length > 320) return false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(env.EMAIL_BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ secret: env.EMAIL_BRIDGE_SECRET, to: message.to, subject: message.subject, text: message.text, html: message.html }),
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) return false
    const result = await response.json().catch(() => null) as { ok?: boolean } | null
    return result?.ok === true
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}
