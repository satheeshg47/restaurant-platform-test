import { createRemoteJWKSet, jwtVerify } from 'jose'

export function createOidcIdentityVerifier(config, { verify = jwtVerify, jwks = null } = {}) {
  if (!config?.oidcIssuer || !config?.oidcAudience || !config?.oidcJwksUrl) {
    throw new Error('OIDC identity verification is not configured')
  }
  const keySet = jwks ?? createRemoteJWKSet(new URL(config.oidcJwksUrl))
  return async function authenticateIdentity(request) {
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(request.headers?.authorization ?? '')
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
      if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('Missing subject')

      // Email is useful for invitations only when the identity provider marks
      // the claim as verified. Never infer verification from the presence of
      // an email string, and keep the stable issuer/subject as the identity key.
      const emailVerified = payload.email_verified === true &&
        typeof payload.email === 'string' &&
        payload.email.trim().length > 0

      return Object.freeze({
        issuer: payload.iss,
        subject: payload.sub,
        email: emailVerified ? payload.email.trim() : null,
        emailVerified,
      })
    } catch {
      const error = new Error('Invalid identity credentials')
      error.statusCode = 401
      throw error
    }
  }
}
