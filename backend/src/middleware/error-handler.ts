import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ProviderError } from '../providers/types.js'

/**
 * Central error handler — shapes all errors into an OpenAI-style error envelope
 * so clients using the OpenAI SDK get a familiar response.
 */
export function errorHandler(err: Error, c: Context): Response {
  const requestId = c.get('requestId') as string | undefined

  if (err instanceof ProviderError) {
    return c.json(
      {
        error: {
          message: err.message,
          type: 'upstream_error',
          code: err.code,
          provider: err.provider,
          request_id: requestId,
        },
      },
      // Hono's Status type is strict; 502 covers upstream failures generically.
      err.status >= 400 && err.status < 600 ? (err.status as 400) : 502
    )
  }

  if (err instanceof HTTPException) {
    return c.json(
      {
        error: {
          message: err.message,
          type: 'request_error',
          code: `http_${err.status}`,
          request_id: requestId,
        },
      },
      err.status
    )
  }

  console.error('[error]', { requestId, err: err.message, stack: err.stack })
  return c.json(
    {
      error: {
        message: 'Internal server error',
        type: 'internal_error',
        code: 'internal_error',
        request_id: requestId,
      },
    },
    500
  )
}
