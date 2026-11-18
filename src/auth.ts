import { createRemoteJWKSet, jwtVerify } from 'jose'

const env = import.meta.env as unknown as Record<string, string | undefined>
type Transaction = { state: string; nonce: string; verifier: string; redirectUri: string; returnTo: string }
type Metadata = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
const KEY = 'platformcore.oidc.transaction'
let sessionToken: string | null = null

export function setSessionToken(token: string | null) { sessionToken = token }

function isConfiguredApiRequest(input: RequestInfo | URL) {
  if (typeof window === 'undefined') return false
  try {
    const requestUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    const target = new URL(requestUrl, window.location.origin)
    const apiBase = new URL(env.VITE_API_BASE_URL || '/api', window.location.origin)
    let basePath = apiBase.pathname
    while (basePath.length > 1 && basePath.endsWith('/')) basePath = basePath.slice(0, -1)
    const withinApiPath = basePath === '/' || target.pathname === basePath || target.pathname.startsWith(basePath + '/')
    return target.origin === apiBase.origin && withinApiPath
  } catch {
    return false
  }
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  if (sessionToken && sessionToken !== 'native' && isConfiguredApiRequest(input) && !headers.has('Authorization')) {
    headers.set('Authorization', 'Bearer ' + sessionToken)
  }
  const credentials = init.credentials || (isConfiguredApiRequest(input) ? 'same-origin' : undefined)
  return fetch(input, { ...init, headers, ...(credentials ? { credentials } : {}) })
}

export function getOidcSettings() {
  const issuer = (env.VITE_OIDC_ISSUER || '').trim()
  const clientId = (env.VITE_OIDC_CLIENT_ID || '').trim()
  const apiAudience = (env.VITE_OIDC_API_AUDIENCE || '').trim()
  const redirectUri = (env.VITE_OIDC_REDIRECT_URI || (typeof window !== 'undefined' ? window.location.origin + '/auth/callback' : '')).trim()
  if (!issuer || !clientId || !apiAudience || !redirectUri) return null
  try {
    const issuerUrl = new URL(issuer)
    const redirectUrl = new URL(redirectUri)
    const localDevelopment = redirectUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirectUrl.hostname)
    if (issuerUrl.protocol !== 'https:' || (redirectUrl.protocol !== 'https:' && !localDevelopment)) return null
    if (redirectUrl.pathname !== '/auth/callback' || redirectUrl.search || redirectUrl.hash) return null
    if (typeof window !== 'undefined' && redirectUrl.origin !== window.location.origin) return null
  } catch { return null }
  return { issuer, clientId, apiAudience, redirectUri }
}

function b64url(bytes: Uint8Array) {
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary).split('+').join('-').split('/').join('_').replace(/=+$/g, '')
}
function randomValue(size = 32) {
  const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return b64url(bytes)
}
async function challenge(verifier: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}
async function discovery(settings: NonNullable<ReturnType<typeof getOidcSettings>>): Promise<Metadata> {
  const discoveryUrl = (settings.issuer.endsWith('/') ? settings.issuer.slice(0, -1) : settings.issuer) + '/.well-known/openid-configuration'
  const response = await fetch(discoveryUrl, { cache: 'no-store' })
  if (!response.ok) throw new Error('Identity provider discovery failed.')
  const metadata = await response.json() as Metadata
  if (metadata.issuer !== settings.issuer) throw new Error('Identity provider issuer does not match configuration.')
  if (new URL(metadata.authorization_endpoint).protocol !== 'https:' || new URL(metadata.token_endpoint).protocol !== 'https:' || new URL(metadata.jwks_uri).protocol !== 'https:') throw new Error('Identity provider endpoints and JWKS must use HTTPS.')
  return metadata
}

export async function beginOidcLogin(returnPath: string) {
  const settings = getOidcSettings()
  if (!settings) throw new Error('Sign-in is not configured. Set VITE_OIDC_ISSUER, VITE_OIDC_CLIENT_ID and VITE_OIDC_API_AUDIENCE.')
  const metadata = await discovery(settings)
  const transaction: Transaction = {
    state: randomValue(), nonce: randomValue(), verifier: randomValue(48), redirectUri: settings.redirectUri,
    returnTo: returnPath.startsWith('/') && !returnPath.startsWith('//') && returnPath !== '/auth/callback' ? returnPath : '/',
  }
  sessionStorage.setItem(KEY, JSON.stringify(transaction))
  const url = new URL(metadata.authorization_endpoint)
  url.search = new URLSearchParams({
    response_type: 'code', client_id: settings.clientId, redirect_uri: transaction.redirectUri,
    scope: 'openid email profile', state: transaction.state, nonce: transaction.nonce,
    audience: settings.apiAudience,
    code_challenge: await challenge(transaction.verifier), code_challenge_method: 'S256',
  }).toString()
  window.location.assign(url.toString())
}

export async function completeOidcLogin() {
  const settings = getOidcSettings()
  if (!settings) throw new Error('Sign-in provider is not configured.')
  const callback = new URL(window.location.href)
  let transaction: Transaction | null = null
  try {
    const raw = sessionStorage.getItem(KEY)
    if (raw) transaction = JSON.parse(raw) as Transaction
    const code = callback.searchParams.get('code')
    const providerError = callback.searchParams.get('error')
    if (providerError) {
      const safeCode = /^[a-z0-9_.-]{1,80}$/i.test(providerError) ? providerError : 'provider_error'
      const description = (callback.searchParams.get('error_description') || '')
        .replace(/[\\u0000-\\u001f\\u007f]/g, ' ')
        .slice(0, 240)
      throw new Error(description
        ? 'Identity provider error (' + safeCode + '): ' + description
        : 'Identity provider error (' + safeCode + ').')
    }
    if (!transaction || !code || callback.searchParams.get('state') !== transaction.state) throw new Error('Sign-in state validation failed.')
    if (transaction.redirectUri !== settings.redirectUri) throw new Error('Sign-in redirect configuration changed.')
    const metadata = await discovery(settings)
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: transaction.redirectUri, client_id: settings.clientId, code_verifier: transaction.verifier, audience: settings.apiAudience })
    const response = await fetch(metadata.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(), cache: 'no-store' })
    const payload = await response.json().catch(() => ({})) as { id_token?: string; access_token?: string; token_type?: string }
    if (!response.ok || typeof payload.id_token !== 'string' || typeof payload.access_token !== 'string' || !payload.access_token || payload.token_type?.toLowerCase() !== 'bearer') {
      throw new Error('Identity provider did not return a usable ID token and bearer access token.')
    }
    const { payload: claims } = await jwtVerify(
      payload.id_token,
      createRemoteJWKSet(new URL(metadata.jwks_uri)),
      { issuer: settings.issuer, audience: settings.clientId, algorithms: ['RS256', 'ES256'], maxTokenAge: '10m', clockTolerance: 60 },
    )
    if (claims.nonce !== transaction.nonce || typeof claims.sub !== 'string' || !claims.sub ||
        (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== settings.clientId)) {
      throw new Error('ID token validation failed.')
    }
    window.history.replaceState({}, document.title, transaction.returnTo)
    return { accessToken: payload.access_token, idToken: payload.id_token }
  } catch (cause) {
    window.history.replaceState({}, document.title, transaction?.returnTo || '/')
    throw cause
  } finally { sessionStorage.removeItem(KEY) }
}
