import { createHash, timingSafeEqual } from 'node:crypto'
import yauzl from 'yauzl'
import { validateReleaseManifest, validateReleasePackagePath } from './manifest.mjs'

const DEFAULT_LIMITS = {
  maxArchiveBytes: 100 * 1024 * 1024,
  maxEntries: 5000,
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxCompressionRatio: 100,
}

function failure(code, message, path = '') {
  return { valid: false, errors: [{ code, message, path }] }
}

function isSymbolicLink(entry) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  return (unixMode & 0o170000) === 0o120000
}

function isRegularFile(entry) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  const type = unixMode & 0o170000
  return type === 0 || type === 0o100000
}

/**
 * Inspect a bounded ZIP buffer against a previously validated release manifest.
 * The archive is never extracted to disk and no package content is executed.
 */
export async function inspectReleaseArchive(archive, manifestInput, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options }
  const manifestResult = validateReleaseManifest(manifestInput, {
    maxFiles: limits.maxEntries,
    maxFileBytes: limits.maxFileBytes,
    maxTotalBytes: limits.maxTotalBytes,
  })
  if (!manifestResult.valid) {
    return { valid: false, errors: manifestResult.errors.map(error => ({
      code: `manifest_${error.code}`, path: error.path, message: error.message,
    })) }
  }
  if (!Buffer.isBuffer(archive)) return failure('invalid_archive', 'Archive must be supplied as a Buffer.')
  if (archive.length < 22) return failure('invalid_archive', 'ZIP archive is too small or malformed.')
  if (archive.length > limits.maxArchiveBytes) {
    return failure('archive_too_large', `Compressed archive exceeds ${limits.maxArchiveBytes} bytes.`)
  }

  const expectedFiles = new Map(manifestResult.manifest.files.map(file => [file.path, file]))
  const seen = new Set()
  let totalUncompressedBytes = 0
  let fileCount = 0

  return new Promise(resolve => {
    let settled = false
    let zipfile

    const finish = result => {
      if (settled) return
      settled = true
      try { zipfile?.close() } catch {}
      resolve(result)
    }

    yauzl.fromBuffer(archive, {
      lazyEntries: true,
      decodeStrings: true,
      strictFileNames: false,
      validateEntrySizes: true,
    }, (error, openedZip) => {
      if (error || !openedZip) {
        const unsafeName = error && /file.?name|filename|relative path|absolute path/i.test(error.message || '')
        finish(unsafeName
          ? failure('unsafe_archive_path', 'Archive contains an unsafe file path.')
          : failure('invalid_archive', 'ZIP central directory could not be read.'))
        return
      }
      zipfile = openedZip

      if (zipfile.entryCount > limits.maxEntries) {
        finish(failure('too_many_archive_entries', `Archive may contain at most ${limits.maxEntries} entries.`))
        return
      }

      zipfile.on('error', error => {
        const unsafeName = /file.?name|filename|relative path|absolute path/i.test(error?.message || '')
        finish(unsafeName
          ? failure('unsafe_archive_path', 'Archive contains an unsafe file path.')
          : failure('invalid_archive', 'ZIP archive structure or compressed data is invalid.'))
      })
      zipfile.on('end', () => {
        const missing = [...expectedFiles.keys()].filter(path => !seen.has(path))
        if (missing.length) {
          finish(failure('manifest_file_missing', 'One or more manifest files are missing from the archive.', missing[0]))
          return
        }
        finish({
          valid: true,
          summary: {
            app_key: manifestResult.manifest.app_key,
            version: manifestResult.manifest.version,
            file_count: fileCount,
            uncompressed_bytes: totalUncompressedBytes,
            archive_bytes: archive.length,
          },
        })
      })

      zipfile.on('entry', entry => {
        if (settled) return
        const isDirectory = entry.fileName.endsWith('/')
        const normalizedPath = isDirectory ? entry.fileName.slice(0, -1) : entry.fileName

        if (!validateReleasePackagePath(normalizedPath)) {
          finish(failure('unsafe_archive_path', 'Archive contains an unsafe or protected path.', entry.fileName))
          return
        }
        if (seen.has(normalizedPath)) {
          finish(failure('duplicate_archive_path', 'Archive contains duplicate paths.', normalizedPath))
          return
        }
        seen.add(normalizedPath)

        if (isSymbolicLink(entry)) {
          finish(failure('symbolic_link_not_allowed', 'Symbolic links are not allowed in release archives.', normalizedPath))
          return
        }
        if (isDirectory) {
          if (entry.uncompressedSize !== 0) {
            finish(failure('invalid_directory_entry', 'Directory entries must not contain file data.', normalizedPath))
            return
          }
          zipfile.readEntry()
          return
        }
        if (!isRegularFile(entry)) {
          finish(failure('unsupported_archive_entry', 'Only regular files and directories are allowed.', normalizedPath))
          return
        }
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          finish(failure('encrypted_archive_entry', 'Encrypted ZIP entries are not supported.', normalizedPath))
          return
        }
        if (![0, 8].includes(entry.compressionMethod)) {
          finish(failure('unsupported_compression', 'Only stored and deflate ZIP entries are supported.', normalizedPath))
          return
        }
        if (!expectedFiles.has(normalizedPath)) {
          finish(failure('unexpected_archive_file', 'Archive contains a file not listed in the manifest.', normalizedPath))
          return
        }
        if (entry.uncompressedSize > limits.maxFileBytes) {
          finish(failure('archive_file_too_large', `File exceeds ${limits.maxFileBytes} uncompressed bytes.`, normalizedPath))
          return
        }
        if (entry.uncompressedSize > 0 && entry.compressedSize === 0) {
          finish(failure('invalid_compression_ratio', 'Archive entry has an invalid compression size.', normalizedPath))
          return
        }
        if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio) {
          finish(failure('compression_ratio_exceeded', 'Archive entry exceeds the allowed compression ratio.', normalizedPath))
          return
        }
        totalUncompressedBytes += entry.uncompressedSize
        if (totalUncompressedBytes > limits.maxTotalBytes) {
          finish(failure('archive_too_large_uncompressed', `Uncompressed package exceeds ${limits.maxTotalBytes} bytes.`))
          return
        }

        const expected = expectedFiles.get(normalizedPath)
        if (entry.uncompressedSize !== expected.size_bytes) {
          finish(failure('archive_size_mismatch', 'Archive file size does not match the manifest.', normalizedPath))
          return
        }

        zipfile.openReadStream(entry, (streamError, stream) => {
          if (settled) return
          if (streamError || !stream) {
            finish(failure('archive_read_failed', 'Archive file could not be read.', normalizedPath))
            return
          }
          const hash = createHash('sha256')
          let bytesRead = 0
          stream.on('data', chunk => {
            bytesRead += chunk.length
            if (bytesRead > expected.size_bytes || bytesRead > limits.maxFileBytes) {
              stream.destroy(new Error('entry size limit exceeded'))
              return
            }
            hash.update(chunk)
          })
          stream.on('error', () => finish(failure('archive_read_failed', 'Archive file data is corrupt or unreadable.', normalizedPath)))
          stream.on('end', () => {
            if (settled) return
            const actualHash = Buffer.from(hash.digest('hex'), 'hex')
            const expectedHash = Buffer.from(expected.sha256, 'hex')
            if (bytesRead !== expected.size_bytes || actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
              finish(failure('archive_hash_mismatch', 'Archive file content does not match the manifest SHA-256.', normalizedPath))
              return
            }
            fileCount += 1
            zipfile.readEntry()
          })
        })
      })

      zipfile.readEntry()
    })
  })
}
