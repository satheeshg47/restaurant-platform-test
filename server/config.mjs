const DEFAULT_PORT = 8787

function loadObjectStorage(env) {
  const endpoint = env.OBJECT_STORAGE_ENDPOINT || ''
  const bucket = env.OBJECT_STORAGE_BUCKET || ''
  const region = env.OBJECT_STORAGE_REGION || ''
  const accessKeyId = env.OBJECT_STORAGE_ACCESS_KEY_ID || ''
  const secretAccessKey = env.OBJECT_STORAGE_SECRET_ACCESS_KEY || ''
  const values = [endpoint, bucket, region, accessKeyId, secretAccessKey]
  if (!values.some(Boolean)) return null
  if (!values.every(Boolean)) {
    throw new Error('OBJECT_STORAGE_ENDPOINT, BUCKET, REGION, ACCESS_KEY_ID and SECRET_ACCESS_KEY must be configured together')
  }
  let parsed
  try { parsed = new URL(endpoint) } catch { throw new Error('OBJECT_STORAGE_ENDPOINT must be a valid HTTPS URL') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('OBJECT_STORAGE_ENDPOINT must be a clean HTTPS URL')
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) {
    throw new Error('OBJECT_STORAGE_BUCKET is invalid')
  }
  if (!/^[a-z0-9-]{1,64}$/.test(region) || !/^[A-Za-z0-9]{8,128}$/.test(accessKeyId) || secretAccessKey.length < 16) {
    throw new Error('Object storage credentials or region are invalid')
  }
  return Object.freeze({ endpoint: parsed.origin + parsed.pathname.replace(/\/$/, ''), bucket, region, accessKeyId, secretAccessKey })
}

export function loadConfig(env = process.env) {
  const port = Number(env.API_PORT ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('API_PORT must be an integer between 1 and 65535')
  }

  const oidcIssuer = env.OIDC_ISSUER || ''
  const oidcAudience = env.OIDC_AUDIENCE || ''
  const oidcClientId = env.OIDC_CLIENT_ID || ''
  const oidcJwksUrl = env.OIDC_JWKS_URL || ''
  const adminIssuer = env.PLATFORM_ADMIN_ISSUER || oidcIssuer
  const adminSubject = env.PLATFORM_ADMIN_SUBJECT || ''
  const oidcValues = [oidcIssuer, oidcAudience, oidcClientId, oidcJwksUrl, adminSubject]
  const oidcConfigured = oidcValues.every(Boolean)

  if (oidcValues.some(Boolean) && !oidcConfigured) {
    throw new Error('OIDC_ISSUER, OIDC_AUDIENCE, OIDC_CLIENT_ID, OIDC_JWKS_URL and PLATFORM_ADMIN_SUBJECT must be configured together')
  }
  if (oidcConfigured) {
    let issuerUrl
    let jwksUrl
    try {
      issuerUrl = new URL(oidcIssuer)
      jwksUrl = new URL(oidcJwksUrl)
    } catch {
      throw new Error('OIDC_ISSUER and OIDC_JWKS_URL must be valid URLs')
    }
    if (issuerUrl.protocol !== 'https:' || jwksUrl.protocol !== 'https:') {
      throw new Error('OIDC issuer and JWKS URLs must use HTTPS')
    }
  }

  return Object.freeze({
    host: env.API_HOST ?? '0.0.0.0',
    port,
    environment: env.NODE_ENV ?? 'development',
    oidcIssuer,
    oidcAudience,
    oidcClientId,
    oidcJwksUrl,
    adminIssuer,
    adminSubject,
    adminAuthConfigured: oidcConfigured,
    objectStorage: loadObjectStorage(env),
  })
}
