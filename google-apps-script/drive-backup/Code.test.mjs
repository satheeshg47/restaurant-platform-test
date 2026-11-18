import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

test('Google Apps Script backup bridge parses as V8 JavaScript', () => {
  const source = readFileSync(new URL('./Code.gs', import.meta.url), 'utf8')
  assert.doesNotThrow(() => new Script(source, { filename: 'Code.gs' }))
  assert.match(source, /current_bookmark/)
  assert.match(source, /PENDING_SIGNED_URL/)
  assert.match(source, /sha256_compressed/)
  assert.doesNotMatch(source, /DELETE\s+FROM/i)
})
