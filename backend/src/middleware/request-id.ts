import type { MiddlewareHandler } from 'hono'
import crypto from 'node:crypto'

/**
 * Attach a request id to the context and response header. Uses an incoming
 * `x-request-id` header if present, otherwise generates one.
 */
export function requestId(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id')
    const id = incoming ?? `req_${crypto.randomBytes(8).toString('hex')}`
    c.set('requestId', id)
    c.header('x-request-id', id)
    await next()
  }
}
