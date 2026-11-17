const APP_KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const BLOCKED_SEGMENTS = new Set([
  '.git', 'node_modules', '.env', 'data', 'uploads', 'storage',
  'backups', 'customer-data', 'tenant-data',
])
const MANIFEST_KEYS = ['schema_version', 'app_key', 'version', 'database_migration_version', 'files']
const FILE_KEYS = ['path', 'sha256', 'size_bytes']

function issue(errors, code, path, message) {
  errors.push({ code, path, message })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key))
}

export function validateReleasePackagePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
  if (value.startsWith('/') || value.includes('\\') || /^[a-zA-Z]:/.test(value)) return false
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  const segments = value.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false
  if (segments.some(segment => {
    const normalized = segment.toLowerCase()
    return BLOCKED_SEGMENTS.has(normalized) || normalized.startsWith('.env')
  })) return false
  return true
}

/**
 * Validate the metadata contract for an application release package.
 * This does not extract or execute ZIP contents; callers must separately
 * compare every archive entry against the validated file list and hashes.
 */
export function validateReleaseManifest(input, {
  maxFiles = 5000,
  maxFileBytes = 100 * 1024 * 1024,
  maxTotalBytes = 500 * 1024 * 1024,
} = {}) {
  const errors = []
  if (!isRecord(input)) {
    return { valid: false, errors: [{ code: 'invalid_manifest', path: '', message: 'Manifest must be a JSON object.' }] }
  }

  if (!hasOnlyKeys(input, MANIFEST_KEYS)) {
    issue(errors, 'unknown_manifest_field', '', 'Manifest contains unsupported fields.')
  }
  if (input.schema_version !== 1) {
    issue(errors, 'unsupported_schema_version', 'schema_version', 'Only manifest schema version 1 is supported.')
  }
  if (typeof input.app_key !== 'string' || !APP_KEY_PATTERN.test(input.app_key)) {
    issue(errors, 'invalid_app_key', 'app_key', 'Application key must be 2–63 lowercase letters, numbers or hyphens and start with a letter.')
  }
  if (typeof input.version !== 'string' || !VERSION_PATTERN.test(input.version)) {
    issue(errors, 'invalid_version', 'version', 'Version must use semantic versioning, for example 1.2.3.')
  }
  if (!Number.isSafeInteger(input.database_migration_version) || input.database_migration_version < 0) {
    issue(errors, 'invalid_migration_version', 'database_migration_version', 'Database migration version must be a non-negative safe integer.')
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    issue(errors, 'invalid_files', 'files', 'Manifest must list at least one package file.')
  } else {
    if (input.files.length > maxFiles) {
      issue(errors, 'too_many_files', 'files', `Package may contain at most ${maxFiles} files.`)
    }
    const seen = new Set()
    let totalBytes = 0
    input.files.forEach((file, index) => {
      const location = `files[${index}]`
      if (!isRecord(file)) {
        issue(errors, 'invalid_file_entry', location, 'Each file entry must be a JSON object.')
        return
      }
      if (!hasOnlyKeys(file, FILE_KEYS)) {
        issue(errors, 'unknown_file_field', location, 'File entry contains unsupported fields.')
      }
      if (!validateReleasePackagePath(file.path)) {
        issue(errors, 'unsafe_file_path', `${location}.path`, 'File path must be a safe relative POSIX path and must not target protected data or dependency directories.')
      } else if (seen.has(file.path)) {
        issue(errors, 'duplicate_file_path', `${location}.path`, 'Package file paths must be unique.')
      } else {
        seen.add(file.path)
      }
      if (typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)) {
        issue(errors, 'invalid_file_hash', `${location}.sha256`, 'File SHA-256 must be 64 lowercase hexadecimal characters.')
      }
      if (!Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0) {
        issue(errors, 'invalid_file_size', `${location}.size_bytes`, 'File size must be a non-negative safe integer.')
      } else {
        totalBytes += file.size_bytes
        if (file.size_bytes > maxFileBytes) {
          issue(errors, 'invalid_file_size', `${location}.size_bytes`, `File size must not exceed ${maxFileBytes} bytes.`)
        }
      }
    })
    if (totalBytes > maxTotalBytes) {
      issue(errors, 'package_too_large', 'files', `Total package size must not exceed ${maxTotalBytes} bytes.`)
    }
  }

  if (errors.length) return { valid: false, errors }
  return {
    valid: true,
    manifest: {
      schema_version: 1,
      app_key: input.app_key,
      version: input.version,
      database_migration_version: input.database_migration_version,
      files: input.files.map(file => ({
        path: file.path,
        sha256: file.sha256,
        size_bytes: file.size_bytes,
      })),
    },
  }
}
