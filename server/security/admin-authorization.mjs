import { createRemoteJWKSet, jwtVerify } from 'jose'

// Claims must be verified from a signed access token before they are trusted.
// The stable issuer + subject pair identifies the one permitted platform owner.
export function isPlatformAdmin(verifiedClaims, config) {
  if (!verifiedClaims || typeof verifiedClaims !== 'object') return false
  if (!config?.adminIssuer || !config?.adminSubject) return false
  return verifiedClaims.iss === config.adminIssuer &&
    verifiedClaims.sub === config.adminSubject
}

export function requirePlatformAdmin(verifiedClaims, config) {
  if (!isPlatformAdmin(verifiedClaims, config)) {
    const error = new Error('Platform administrator access required')
    error.statusCode = 403
    throw error
  }
}

export function createAdminTokenVerifier(config, { verify = jwtVerify, jwks = null } = {}) {
  if (!config?.adminAuthConfigured) {
    throw new Error('OIDC administrator authentication is not configured')
  }
  const keySet = jwks ?? createRemoteJWKSet(new URL(config.oidcJwksUrl))

  return async function authenticateAdminRequest(request) {
    const authorization = request.headers?.authorization ?? ''
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization)
    if (!match) {
      const error = new Error('Authentication required')
      error.statusCode = 401
      throw error
    }

    try {
      const { payload } = await verify(match[1], keySet, {
        issuer: config.oidcIssuer,
        audience: config.oidcAudience,
        algorithms: ['RS256', 'ES256'],
      })
      requirePlatformAdmin(payload, config)
      return Object.freeze({ issuer: payload.iss, subject: payload.sub })
    } catch (cause) {
      const statusCode = cause.statusCode === 403 ? 403 : 401
      const error = new Error(statusCode === 403 ? 'Platform administrator access required' : 'Invalid administrator credentials')
      error.statusCode = statusCode
      throw error
    }
  }
}
