import test from 'node:test'
import assert from 'node:assert/strict'
import { createPresignedObjectUrl, createRestaurantObjectKey } from './object-storage.mjs'

const storage = {
  endpoint: 'https://objects.example.test',
  bucket: 'private-media',
  region: 'ap-south-1',
  accessKeyId: 'ACCESSKEY12345678',
  secretAccessKey: 'a-secret-key-that-is-long-enough',
}

test('creates a short-lived private PUT URL bound to an image content type', () => {
  const value = createPresignedObjectUrl(storage, {
    method: 'PUT',
    key: 'restaurants/tenant/menu/item.webp',
    contentType: 'image/webp',
    expiresSeconds: 240,
    now: new Date('2026-11-17T04:00:00.000Z'),
  })
  const url = new URL(value)
  assert.equal(url.protocol, 'https:')
  assert.equal(url.pathname, '/private-media/restaurants/tenant/menu/item.webp')
  assert.equal(url.searchParams.get('X-Amz-Expires'), '240')
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host')
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/)
})

test('creates a short-lived private GET URL', () => {
  const url = new URL(createPresignedObjectUrl(storage, {
    method: 'GET',
    key: 'restaurants/tenant/menu/item.jpg',
    now: new Date('2026-11-17T04:00:00.000Z'),
  }))
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host')
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300')
})

test('rejects unsafe object keys and unsupported operations', () => {
  assert.throws(() => createPresignedObjectUrl(storage, { method: 'GET', key: '../secret' }), /Invalid object key/)
  assert.throws(() => createPresignedObjectUrl(storage, { method: 'DELETE', key: 'safe/file' }), /Unsupported object operation/)
})

test('rejects public or unsupported upload content types and long expiries', () => {
  assert.throws(() => createPresignedObjectUrl(storage, { method: 'PUT', key: 'safe/file.svg', contentType: 'image/svg+xml' }), /Unsupported image content type/)
  assert.throws(() => createPresignedObjectUrl(storage, { method: 'GET', key: 'safe/file', expiresSeconds: 3600 }), /between 1 and 900/)
})

test('fails closed when storage is not configured', () => {
  assert.throws(() => createPresignedObjectUrl(null, { method: 'GET', key: 'safe/file' }), /not configured/)
})

test('builds tenant-scoped menu object keys from validated identifiers', () => {
  assert.equal(
    createRestaurantObjectKey('123e4567-e89b-42d3-a456-426614174000', '123e4567-e89b-42d3-a456-426614174001', 'webp'),
    'restaurants/123e4567-e89b-42d3-a456-426614174000/menu/123e4567-e89b-42d3-a456-426614174001.webp',
  )
  assert.throws(() => createRestaurantObjectKey('tenant', 'item', 'svg'), /Invalid restaurant media identity/)
})


test('creates a short-lived signed HEAD URL for upload completion verification', () => {
  const url = new URL(createPresignedObjectUrl(storage, {
    method: 'HEAD',
    key: 'restaurants/tenant/menu/item.webp',
    expiresSeconds: 60,
    now: new Date('2026-11-17T04:00:00.000Z'),
  }))
  assert.equal(url.searchParams.get('X-Amz-Expires'), '60')
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host')
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/)
})
