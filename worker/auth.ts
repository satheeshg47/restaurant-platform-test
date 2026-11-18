import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Env, Identity } from './types.ts'
import { authenticateNativeSession } from './native-auth.ts'

function authError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

async function verifyToken(token: string, env: Env, audience: string, authorizedParty = env.OIDC_CLIENT_ID): Promise<Identity> {
  if (!env.OIDC_ISSUER || !env.OIDC_JWKS_URL || !audience) throw authError('identity_provider_not_configured', 503)
  try {
    const { payload } = await jwtVerify(
      token,
      createRemoteJWKSet(new URL(env.OIDC_JWKS_URL)),
      { issuer: env.OIDC_ISSUER, audience, algorithms: ['RS256', 'ES256'], clockTolerance: 60 },
    )
    if (typeof payload.sub !== 'string' || !payload.sub) throw authError('invalid_identity', 401)
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && (!authorizedParty || payload.azp !== authorizedParty)) {
      throw authError('invalid_authorized_party', 401)
    }
    return {
      issuer: env.OIDC_ISSUER,
      subject: payload.sub,
      ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
      emailVerified: payload.email_verified === true,
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error
    throw authError('unauthorized', 401)
  }
}

function bearer(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(request.headers.get('Authorization') || '')
  if (!match) throw authError('unauthorized', 401)
  return match[1]
}

export async function authenticateIdentity(request: Request, env: Env): Promise<Identity> {
  const nativeIdentity = await authenticateNativeSession(request, env)
  if (nativeIdentity) return nativeIdentity
  if (!env.OIDC_AUDIENCE) throw authError('owner_auth_not_configured', 503)
  return verifyToken(bearer(request), env, env.OIDC_AUDIENCE)
}

export async function authenticateAdmin(request: Request, env: Env): Promise<Identity> {
  const identity = await authenticateIdentity(request, env)
  if (identity.issuer === 'native') {
    const admin = await env.DB.prepare(
      "SELECT 1 AS allowed FROM platform_admin_accounts WHERE user_id=? AND status='active'",
    ).bind(identity.subject).first()
    if (!admin) throw authError('forbidden', 403)
    return identity
  }
  if (!env.PLATFORM_ADMIN_SUBJECT) throw authError('admin_auth_not_configured', 503)
  if (identity.subject !== env.PLATFORM_ADMIN_SUBJECT) throw authError('forbidden', 403)
  return identity
}

export async function authenticateVerifiedEmail(request: Request, env: Env): Promise<Identity> {
  if (!env.OIDC_CLIENT_ID) throw authError('verified_email_auth_not_configured', 503)
  const token = request.headers.get('X-OIDC-ID-Token') || ''
  if (!token || !/^[A-Za-z0-9._~-]+$/.test(token)) throw authError('id_token_required', 401)
  const identity = await verifyToken(token, env, env.OIDC_CLIENT_ID)
  if (!identity.email || !identity.emailVerified) throw authError('verified_email_required', 403)
  return identity
}

export function authStatus(error: unknown, fallback = 401): number {
  return error && typeof error === 'object' && 'status' in error ? Number(error.status) : fallback
}
