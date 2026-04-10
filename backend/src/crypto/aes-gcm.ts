/**
 * AES-256-GCM envelope encryption for API keys at rest.
 *
 * Storage format (base64):
 *   version (1 byte) || iv (12 bytes) || ciphertext (var) || authTag (16 bytes)
 *
 * The version byte enables key rotation — each record records which key version
 * encrypted it, and a keyring resolves versions to raw keys.
 *
 * IV MUST be 12 bytes (NIST SP 800-38D). Never reuse (IV, key) pairs — with
 * random 96-bit IVs, rotate keys before ~4.3B encryptions per key.
 */
import crypto from 'node:crypto'
import { loadEnv } from '../config/env.js'

const ALGORITHM = 'aes-256-gcm'
export const IV_LENGTH = 12
export const AUTH_TAG_LENGTH = 16
const VERSION_LENGTH = 1

export interface KeyRing {
  /** Map of version -> raw key buffer. */
  keys: Map<number, Buffer>
  /** Version to use for NEW encryptions (highest available). */
  currentVersion: number
}

let cachedKeyring: KeyRing | null = null

/** Build the keyring from env. Supports single key or JSON map. */
export function getKeyring(): KeyRing {
  if (cachedKeyring) return cachedKeyring
  const env = loadEnv()
  const keys = new Map<number, Buffer>()

  if (env.ENCRYPTION_KEY_RING) {
    let parsed: Record<string, string>
    try {
      parsed = JSON.parse(env.ENCRYPTION_KEY_RING)
    } catch {
      throw new Error('ENCRYPTION_KEY_RING must be valid JSON: {"1":"<64 hex>",...}')
    }
    for (const [v, hex] of Object.entries(parsed)) {
      const version = parseInt(v, 10)
      if (!Number.isInteger(version) || version < 1 || version > 255) {
        throw new Error(`Invalid keyring version: ${v}`)
      }
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(`Keyring entry v${v} must be 64 hex chars`)
      }
      keys.set(version, Buffer.from(hex, 'hex'))
    }
  } else if (env.MASTER_ENCRYPTION_KEY) {
    keys.set(1, Buffer.from(env.MASTER_ENCRYPTION_KEY, 'hex'))
  } else {
    throw new Error(
      'No encryption key configured. Set MASTER_ENCRYPTION_KEY or ENCRYPTION_KEY_RING.'
    )
  }

  if (keys.size === 0) throw new Error('Empty encryption keyring')
  const currentVersion = Math.max(...keys.keys())
  cachedKeyring = { keys, currentVersion }
  return cachedKeyring
}

/** Encrypt UTF-8 plaintext with the current (highest) key version. */
export function encrypt(plaintext: string, keyring: KeyRing = getKeyring()): string {
  const key = keyring.keys.get(keyring.currentVersion)
  if (!key) throw new Error(`Missing key for version ${keyring.currentVersion}`)

  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return Buffer.concat([Buffer.from([keyring.currentVersion]), iv, encrypted, authTag]).toString(
    'base64'
  )
}

/** Decrypt a base64 blob produced by encrypt(). Throws on tamper / wrong key. */
export function decrypt(encryptedBase64: string, keyring: KeyRing = getKeyring()): string {
  const data = Buffer.from(encryptedBase64, 'base64')
  const minLength = VERSION_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
  if (data.length < minLength) {
    throw new Error('Invalid encrypted payload: too short')
  }

  const version = data[0]!
  const key = keyring.keys.get(version)
  if (!key) {
    throw new Error(`Unknown key version: ${version}`)
  }

  const iv = data.subarray(VERSION_LENGTH, VERSION_LENGTH + IV_LENGTH)
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH)
  const ciphertext = data.subarray(VERSION_LENGTH + IV_LENGTH, data.length - AUTH_TAG_LENGTH)

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  // MUST be called before final() — do not remove.
  decipher.setAuthTag(authTag)

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Decryption failed: data tampered or wrong key')
  }
}

/** Extract just the version byte without decrypting (for migration tooling). */
export function getVersionOf(encryptedBase64: string): number {
  const data = Buffer.from(encryptedBase64, 'base64')
  if (data.length < 1) throw new Error('Invalid payload')
  return data[0]!
}

/** Re-encrypt a value with the current key version (for rotation). */
export function rewrap(encryptedBase64: string, keyring: KeyRing = getKeyring()): string {
  const plaintext = decrypt(encryptedBase64, keyring)
  return encrypt(plaintext, keyring)
}

/** Generate a fresh 32-byte key as hex — convenience for operators. */
export function generateKey(): string {
  return crypto.randomBytes(32).toString('hex')
}

/** Constant-time comparison helper. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** Reset cached keyring (for tests). */
export function _resetKeyringCache(): void {
  cachedKeyring = null
}
