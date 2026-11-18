import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createTotpSecret, decryptTotpSecret, encryptTotpSecret, generateTotpCode, hashPassword,
  sha256Hex, totpProvisioningUri, verifyPassword, verifyTotp,
} from './native-auth-crypto.ts'

const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

test('password hashes are salted, versioned and verified', async () => {
  const first = await hashPassword('a-strong-test-password-123')
  const second = await hashPassword('a-strong-test-password-123')
  assert.notEqual(first, second)
  assert.match(first, /^pbkdf2-sha256\$100000\$/)
  assert.equal(await verifyPassword('a-strong-test-password-123', first), true)
  assert.equal(await verifyPassword('wrong-password-value', first), false)
  assert.equal(await verifyPassword('a-strong-test-password-123', first.replace('100000', '1')), false)
})

test('TOTP secrets provision and verify with a bounded clock window', async () => {
  const secret = createTotpSecret()
  const now = 1_700_000_000_000
  const uri = totpProvisioningUri(secret, 'admin-login')
  assert.match(uri, /^otpauth:\/\/totp\//)
  assert.match(uri, /issuer=Platform\+Core/)
  const code = await generateTotpCode(secret, now)
  assert.equal(await verifyTotp(secret, code, now), true)
  assert.equal(await verifyTotp(secret, code, now + 180_000, 0), false)
  assert.equal(await verifyTotp(secret, '00000x', now), false)
  assert.equal(await verifyTotp(secret, '123456', now, 0), false)
})

test('TOTP secret encryption is authenticated and rejects tampering', async () => {
  const secret = createTotpSecret()
  const encrypted = await encryptTotpSecret(secret, key)
  assert.notEqual(encrypted, secret)
  assert.equal(await decryptTotpSecret(encrypted, key), secret)
  await assert.rejects(() => decryptTotpSecret(encrypted + 'x', key))
  await assert.rejects(() => decryptTotpSecret(encrypted, 'invalid'))
})

test('SHA-256 helper returns a stable lowercase digest', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
