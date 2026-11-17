import { createHash, createHmac } from 'node:crypto'

const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'
const MAX_EXPIRY_SECONDS = 900

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding)
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
}

function canonicalQuery(params) {
  return [...params.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
    .map(([key, value]) => key + '=' + value)
    .join('&')
}

function safeObjectKey(key) {
  if (typeof key !== 'string' || key.length < 1 || key.length > 900 ||
      key.startsWith('/') || key.includes('\\') ||
      key.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new TypeError('Invalid object key')
  }
  return key
}

function signingKey(secret, date, region) {
  const dateKey = hmac('AWS4' + secret, date)
  const regionKey = hmac(dateKey, region)
  const serviceKey = hmac(regionKey, SERVICE)
  return hmac(serviceKey, 'aws4_request')
}

export function createPresignedObjectUrl(storage, {
  method,
  key,
  expiresSeconds = 300,
  contentType,
  now = new Date(),
}) {
  if (!storage) throw new Error('Object storage is not configured')
  if (!['GET', 'HEAD', 'PUT'].includes(method)) throw new TypeError('Unsupported object operation')
  safeObjectKey(key)
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > MAX_EXPIRY_SECONDS) {
    throw new RangeError('Presigned URL expiry must be between 1 and 900 seconds')
  }
  if (method === 'PUT' && (!contentType || !/^image\/(jpeg|png|webp|avif)$/.test(contentType))) {
    throw new TypeError('Unsupported image content type')
  }

  const endpoint = new URL(storage.endpoint)
  if (endpoint.protocol !== 'https:') throw new TypeError('Storage endpoint must use HTTPS')
  const pathPrefix = endpoint.pathname.replace(/\/$/, '')
  const canonicalUri = (pathPrefix + '/' + awsEncode(storage.bucket) + '/' + key.split('/').map(awsEncode).join('/')) || '/'
  const url = new URL(endpoint.origin + canonicalUri)
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = date.slice(0, 8)
  const scope = day + '/' + storage.region + '/' + SERVICE + '/aws4_request'
  const signedHeaders = method === 'PUT' ? 'content-type;host' : 'host'
  const params = new URLSearchParams({
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': storage.accessKeyId + '/' + scope,
    'X-Amz-Date': date,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
  })
  const query = canonicalQuery(params)
  const headers = method === 'PUT' ? 'content-type:' + contentType + '\nhost:' + url.host + '\n' : 'host:' + url.host + '\n'
  const canonicalRequest = [method, canonicalUri, query, headers, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = [ALGORITHM, date, scope, sha256(canonicalRequest)].join('\n')
  const signature = hmac(signingKey(storage.secretAccessKey, day, storage.region), stringToSign, 'hex')
  params.set('X-Amz-Signature', signature)
  url.search = canonicalQuery(params)
  return url.toString()
}

export function createRestaurantObjectKey(tenantId, itemId, extension) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuid.test(tenantId || '') || !uuid.test(itemId || '') || !['jpg', 'png', 'webp', 'avif'].includes(extension)) {
    throw new TypeError('Invalid restaurant media identity')
  }
  return 'restaurants/' + tenantId + '/menu/' + itemId + '.' + extension
}
