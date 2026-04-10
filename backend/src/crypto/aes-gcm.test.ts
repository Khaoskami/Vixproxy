import { describe, it, expect, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import {
  encrypt,
  decrypt,
  rewrap,
  generateKey,
  getVersionOf,
  _resetKeyringCache,
  type KeyRing,
} from './aes-gcm.js'

function makeRing(versions: Record<number, string>): KeyRing {
  const keys = new Map<number, Buffer>()
  for (const [v, hex] of Object.entries(versions)) {
    keys.set(Number(v), Buffer.from(hex, 'hex'))
  }
  return { keys, currentVersion: Math.max(...keys.keys()) }
}

describe('aes-gcm', () => {
  beforeEach(() => _resetKeyringCache())

  const v1 = crypto.randomBytes(32).toString('hex')
  const v2 = crypto.randomBytes(32).toString('hex')
  const ring1: KeyRing = makeRing({ 1: v1 })
  const ring2: KeyRing = makeRing({ 1: v1, 2: v2 })

  it('round-trips plaintext', () => {
    const ct = encrypt('sk-test-abcdef12345', ring1)
    expect(decrypt(ct, ring1)).toBe('sk-test-abcdef12345')
  })

  it('produces different ciphertext each call (random IV)', () => {
    const a = encrypt('same', ring1)
    const b = encrypt('same', ring1)
    expect(a).not.toBe(b)
  })

  it('detects tampering via auth tag', () => {
    const ct = encrypt('secret', ring1)
    const buf = Buffer.from(ct, 'base64')
    buf[buf.length - 1] ^= 0xff // flip a bit in the auth tag
    expect(() => decrypt(buf.toString('base64'), ring1)).toThrow(/Decryption failed/)
  })

  it('detects unknown key version', () => {
    const stranger = makeRing({ 9: crypto.randomBytes(32).toString('hex') })
    const ct = encrypt('secret', stranger)
    expect(() => decrypt(ct, ring1)).toThrow(/Unknown key version/)
  })

  it('encrypts new payloads with highest version', () => {
    const ct = encrypt('hi', ring2)
    expect(getVersionOf(ct)).toBe(2)
  })

  it('can decrypt old-version payloads after rotation', () => {
    const oldCt = encrypt('old-secret', ring1)
    expect(getVersionOf(oldCt)).toBe(1)
    // ring2 includes v1, so it should still decrypt
    expect(decrypt(oldCt, ring2)).toBe('old-secret')
  })

  it('rewrap upgrades to current version', () => {
    const oldCt = encrypt('rotateable', ring1)
    const newCt = rewrap(oldCt, ring2)
    expect(getVersionOf(newCt)).toBe(2)
    expect(decrypt(newCt, ring2)).toBe('rotateable')
  })

  it('generateKey returns 64 hex chars', () => {
    const k = generateKey()
    expect(k).toMatch(/^[0-9a-f]{64}$/)
  })

  it('handles empty string', () => {
    const ct = encrypt('', ring1)
    expect(decrypt(ct, ring1)).toBe('')
  })

  it('handles unicode', () => {
    const input = '🔐 hello 世界 café'
    const ct = encrypt(input, ring1)
    expect(decrypt(ct, ring1)).toBe(input)
  })

  it('rejects truncated payload', () => {
    expect(() => decrypt('AA==', ring1)).toThrow()
  })
})
