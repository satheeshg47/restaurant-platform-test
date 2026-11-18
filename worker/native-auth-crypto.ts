const encoder = new TextEncoder()
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const PBKDF2_ITERATIONS = 600_000
const PBKDF2_MIN_ITERATIONS = 600_000
const PBKDF2_MAX_ITERATIONS = 1_000_000

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_encoding')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) difference |= (a[i % (a.length || 1)] || 0) ^ (b[i % (b.length || 1)] || 0)
  return difference === 0
}

export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 8 || bytes > 64) throw new Error('invalid_random_size')
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('password_length_invalid')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS },
    material,
    256,
  )
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(new Uint8Array(bits))}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 256 || typeof encoded !== 'string' || encoded.length > 256) return false
  const parts = encoded.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false
  const iterations = Number(parts[1])
  if (!Number.isSafeInteger(iterations) || iterations < PBKDF2_MIN_ITERATIONS || iterations > PBKDF2_MAX_ITERATIONS) return false
  try {
    const salt = fromBase64url(parts[2])
    const expected = fromBase64url(parts[3])
    if (salt.length !== 16 || expected.length !== 32) return false
    const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      material,
      256,
    )
    return constantTimeEqual(new Uint8Array(bits), expected)
  } catch {
    return false
  }
}

function decodeBase32(value: string): Uint8Array {
  const normalized = value.toUpperCase().replace(/=+$/g, '')
  if (!normalized || /[^A-Z2-7]/.test(normalized)) throw new Error('invalid_totp_secret')
  let buffer = 0
  let bits = 0
  const output: number[] = []
  for (const char of normalized) {
    buffer = (buffer << 5) | BASE32.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      output.push((buffer >>> bits) & 255)
    }
  }
  return new Uint8Array(output)
}

function encodeBase32(bytes: Uint8Array): string {
  let output = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += BASE32[(buffer >>> bits) & 31]
    }
  }
  if (bits > 0) output += BASE32[(buffer << (5 - bits)) & 31]
  return output
}

export function createTotpSecret(): string {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(20)))
}

async function totpAt(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(decodeBase32(secret)), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const message = new Uint8Array(8)
  let value = BigInt(counter)
  for (let i = 7; i >= 0; i--) { message[i] = Number(value & 255n); value >>= 8n }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  const offset = mac[mac.length - 1] & 15
  const binary = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(binary % 1_000_000).padStart(6, '0')
}

export async function generateTotpCode(secret: string, now = Date.now()): Promise<string> {
  if (!Number.isFinite(now)) throw new Error('invalid_timestamp')
  return totpAt(secret, Math.floor(now / 30_000))
}

export async function verifyTotp(secret: string, code: string, now = Date.now(), window = 1): Promise<boolean> {
  if (!/^\d{6}$/.test(code) || !Number.isFinite(now) || !Number.isInteger(window) || window < 0 || window > 2) return false
  const counter = Math.floor(now / 30_000)
  for (let offset = -window; offset <= window; offset++) {
    if (constantTimeEqual(encoder.encode(await totpAt(secret, counter + offset)), encoder.encode(code))) return true
  }
  return false
}

export function totpProvisioningUri(secret: string, loginId: string): string {
  const issuer = 'Platform Core'
  const label = encodeURIComponent(`${issuer}:${loginId}`)
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${label}?${query.toString()}`
}

function encryptionKeyBytes(value: string): Uint8Array {
  const bytes = fromBase64url(value)
  if (bytes.length !== 32) throw new Error('auth_encryption_key_invalid')
  return bytes
}

export async function encryptTotpSecret(secret: string, keyValue: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(encryptionKeyBytes(keyValue)), 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, encoder.encode(secret))
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`
}

export async function decryptTotpSecret(encrypted: string, keyValue: string): Promise<string> {
  const [version, ivPart, dataPart, extra] = encrypted.split('.')
  if (version !== 'v1' || !ivPart || !dataPart || extra !== undefined) throw new Error('totp_ciphertext_invalid')
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(encryptionKeyBytes(keyValue)), 'AES-GCM', false, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(fromBase64url(ivPart)) }, key, toArrayBuffer(fromBase64url(dataPart)))
  return new TextDecoder().decode(plaintext)
}
