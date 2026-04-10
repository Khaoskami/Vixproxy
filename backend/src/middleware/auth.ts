import type { MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { proxyApiKeys } from '../db/schema.js'

/**
 * Proxy-key auth. Accepts either:
 *   - Authorization: Bearer vx_...
 *   - x-api-key: vx_...
 *
 * Looks up the SHA-256 hash of the key, verifies not revoked/expired, and
 * attaches userId + proxyKeyId to the context.
 *
 * If `DATABASE_URL` is not configured (dev mode), this middleware allows
 * requests through and treats the bare key as the user identifier.
 */
export function proxyKeyAuth(): MiddlewareHandler {
  return async (c, next) => {
    const raw = extractKey(c.req.header('authorization'), c.req.header('x-api-key'))
    if (!raw) {
      throw new HTTPException(401, { message: 'Missing API key' })
    }

    // Dev mode: no DB configured, accept any key and use its hash as identity.
    if (!process.env.DATABASE_URL) {
      c.set('userId', `dev_${hashKey(raw).slice(0, 12)}`)
      c.set('proxyKeyId', hashKey(raw).slice(0, 12))
      await next()
      return
    }

    const db = getDb()
    const hash = hashKey(raw)
    const rows = await db.select().from(proxyApiKeys).where(eq(proxyApiKeys.keyHash, hash)).limit(1)
    const row = rows[0]
    if (!row) {
      throw new HTTPException(401, { message: 'Invalid API key' })
    }
    if (row.revokedAt) {
      throw new HTTPException(401, { message: 'API key revoked' })
    }
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      throw new HTTPException(401, { message: 'API key expired' })
    }

    c.set('userId', row.userId)
    c.set('proxyKeyId', row.id)
    c.set('proxyKeyScopes', row.scopes)
    await next()
  }
}

function extractKey(auth?: string, xApiKey?: string): string | null {
  if (xApiKey) return xApiKey.trim()
  if (!auth) return null
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() ?? null
}

export function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export function generateProxyKey(): { raw: string; hash: string; prefix: string } {
  const random = crypto.randomBytes(24).toString('base64url')
  const raw = `vx_live_${random}`
  return {
    raw,
    hash: hashKey(raw),
    prefix: raw.slice(0, 12),
  }
}
