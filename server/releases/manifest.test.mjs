import assert from 'node:assert/strict'
import test from 'node:test'
import { validateReleaseManifest } from './manifest.mjs'

const validManifest = () => ({
  schema_version: 1,
  app_key: 'restaurant-suite',
  version: '1.2.3',
  database_migration_version: 3,
  files: [
    { path: 'dist/index.html', sha256: 'a'.repeat(64), size_bytes: 1200 },
    { path: 'dist/assets/app.js', sha256: 'b'.repeat(64), size_bytes: 4500 },
  ],
})

test('accepts a valid release manifest and returns a normalized copy', () => {
  const input = validManifest()
  const result = validateReleaseManifest(input)
  assert.equal(result.valid, true)
  assert.equal(result.manifest.app_key, 'restaurant-suite')
  assert.equal(result.manifest.files.length, 2)
  assert.notEqual(result.manifest.files, input.files)
})

test('rejects unsupported schema versions and unknown fields', () => {
  const input = { ...validManifest(), schema_version: 2, customer_data: true }
  const result = validateReleaseManifest(input)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(error => error.code === 'unsupported_schema_version'))
  assert.ok(result.errors.some(error => error.code === 'unknown_manifest_field'))
})

test('accepts semantic version prerelease and build metadata', () => {
  const input = { ...validManifest(), version: '1.2.3-beta.1+build.5' }
  assert.equal(validateReleaseManifest(input).valid, true)
})

test('rejects invalid app keys, versions and migration versions', () => {
  const input = { ...validManifest(), app_key: '../restaurant', version: 'latest', database_migration_version: -1 }
  const result = validateReleaseManifest(input)
  assert.equal(result.valid, false)
  assert.deepEqual(
    result.errors.map(error => error.code).sort(),
    ['invalid_app_key', 'invalid_migration_version', 'invalid_version'].sort(),
  )
})

test('rejects traversal, absolute, windows and protected data paths', () => {
  for (const path of ['../secrets.txt', '/etc/passwd', 'C:/windows/file', 'dist\\\\file.js', 'uploads/customer.csv', 'data/db.sqlite', '.git/config', '.env.production']) {
    const input = validManifest()
    input.files[0].path = path
    const result = validateReleaseManifest(input)
    assert.equal(result.valid, false, `expected unsafe path rejection: ${path}`)
    assert.ok(result.errors.some(error => error.code === 'unsafe_file_path'))
  }
})

test('rejects duplicate file paths and invalid hashes', () => {
  const input = validManifest()
  input.files[1].path = input.files[0].path
  input.files[1].sha256 = 'ABC'
  const result = validateReleaseManifest(input)
  assert.ok(result.errors.some(error => error.code === 'duplicate_file_path'))
  assert.ok(result.errors.some(error => error.code === 'invalid_file_hash'))
})

test('enforces per-file, total-size and file-count limits', () => {
  const input = validManifest()
  input.files[0].size_bytes = 11
  input.files[1].size_bytes = 11
  const result = validateReleaseManifest(input, { maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 15 })
  assert.ok(result.errors.some(error => error.code === 'too_many_files'))
  assert.ok(result.errors.some(error => error.code === 'invalid_file_size'))
  assert.ok(result.errors.some(error => error.code === 'package_too_large'))
})

test('rejects empty or malformed file collections', () => {
  assert.equal(validateReleaseManifest({ ...validManifest(), files: [] }).valid, false)
  assert.equal(validateReleaseManifest(null).valid, false)
})
