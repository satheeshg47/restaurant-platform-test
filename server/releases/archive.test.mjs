import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import yazl from 'yazl'
import { inspectReleaseArchive } from './archive.mjs'

async function makeZip(files) {
  const zip = new yazl.ZipFile()
  for (const [name, contents] of files) {
    zip.addBuffer(Buffer.from(contents), name, { compress: false })
  }
  zip.end()
  const chunks = []
  for await (const chunk of zip.outputStream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function manifestFor(files) {
  return {
    schema_version: 1,
    app_key: 'restaurant-suite',
    version: '1.2.3',
    database_migration_version: 3,
    files: files.map(([path, contents]) => ({
      path,
      sha256: createHash('sha256').update(contents).digest('hex'),
      size_bytes: Buffer.byteLength(contents),
    })),
  }
}

test('accepts a ZIP whose entries exactly match the manifest', async () => {
  const files = [['dist/index.html', '<main>ready</main>'], ['dist/app.js', 'console.log("ok")']]
  const result = await inspectReleaseArchive(await makeZip(files), manifestFor(files))
  assert.equal(result.valid, true)
  assert.equal(result.summary.file_count, 2)
  assert.equal(result.summary.app_key, 'restaurant-suite')
})

test('rejects archive content that does not match the manifest hash', async () => {
  const result = await inspectReleaseArchive(
    await makeZip([['dist/app.js', 'tampered']]),
    manifestFor([['dist/app.js', 'expected']]),
  )
  assert.equal(result.valid, false)
  assert.equal(result.errors[0].code, 'archive_hash_mismatch')
})

test('rejects unlisted files and missing manifest files', async () => {
  const extra = await inspectReleaseArchive(
    await makeZip([['dist/app.js', 'ok'], ['extra.txt', 'unexpected']]),
    manifestFor([['dist/app.js', 'ok']]),
  )
  assert.equal(extra.errors[0].code, 'unexpected_archive_file')

  const missing = await inspectReleaseArchive(
    await makeZip([['dist/app.js', 'ok']]),
    manifestFor([['dist/app.js', 'ok'], ['dist/missing.js', 'missing']]),
  )
  assert.equal(missing.errors[0].code, 'manifest_file_missing')
})

test('rejects unsafe archive paths before reading their contents', async () => {
  const archive = await makeZip([['safe.txt', 'safe']])
  const safeName = Buffer.from('safe.txt')
  const traversalName = Buffer.from('../x.txt')
  assert.equal(safeName.length, traversalName.length)
  let offset = 0
  while ((offset = archive.indexOf(safeName, offset)) !== -1) {
    traversalName.copy(archive, offset)
    offset += traversalName.length
  }
  const result = await inspectReleaseArchive(
    archive,
    manifestFor([['safe.txt', 'safe']]),
  )
  assert.equal(result.valid, false)
  assert.equal(result.errors[0].code, 'unsafe_archive_path')
})

test('rejects malformed and oversized archive buffers', async () => {
  const manifest = manifestFor([['safe.txt', 'safe']])
  const malformed = await inspectReleaseArchive(Buffer.from('not a zip archive'), manifest)
  assert.equal(malformed.errors[0].code, 'invalid_archive')

  const validZip = await makeZip([['safe.txt', 'safe']])
  const oversized = await inspectReleaseArchive(validZip, manifest, { maxArchiveBytes: 10 })
  assert.equal(oversized.errors[0].code, 'archive_too_large')
})

test('rejects archives that exceed the uncompressed file limit', async () => {
  const files = [['dist/large.bin', '12345678901234567890']]
  const result = await inspectReleaseArchive(await makeZip(files), manifestFor(files), { maxFileBytes: 10 })
  assert.equal(result.valid, false)
  assert.equal(result.errors[0].code, 'manifest_invalid_file_size')
})
