import type { Context, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'

/**
 * In-memory sliding-window rate limiter keyed by API key (or client IP).
 *
 * NOTE: this is per-instance. For multi-replica deployments on Railway, swap
 * for a Redis-backed implementation (or Supabase Postgres advisory locks).
 */
interface Bucket {
  windowStart: number
  count: number
}

const buckets = new Map<string, Bucket>()
const WINDOW_MS = 60_000

export interface RateLimitOptions {
  perMinute: number
  /** Key selector — defaults to proxy api key, falling back to IP. */
  keyFn?: (c: Context) => string
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const { perMinute, keyFn } = opts
  return async (c, next) => {
    const key =
      keyFn?.(c) ??
      (c.get('proxyKeyId') as string | undefined) ??
      c.req.header('x-forwarded-for') ??
      c.req.header('cf-connecting-ip') ??
      'anonymous'

    const now = Date.now()
    let bucket = buckets.get(key)
    if (!bucket || now - bucket.windowStart > WINDOW_MS) {
      bucket = { windowStart: now, count: 0 }
      buckets.set(key, bucket)
    }
    bucket.count += 1

    c.header('x-ratelimit-limit', String(perMinute))
    c.header('x-ratelimit-remaining', String(Math.max(0, perMinute - bucket.count)))
    c.header(
      'x-ratelimit-reset',
      String(Math.ceil((bucket.windowStart + WINDOW_MS) / 1000))
    )

    if (bucket.count > perMinute) {
      throw new HTTPException(429, { message: 'Rate limit exceeded' })
    }

    await next()
  }
}

/** Testing hook — reset all buckets. */
export function _resetRateLimit(): void {
  buckets.clear()
}
