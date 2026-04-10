import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { loadEnv } from './config/env.js'
import { requestId } from './middleware/request-id.js'
import { errorHandler } from './middleware/error-handler.js'
import { rateLimit } from './middleware/rate-limit.js'
import { healthRoute } from './routes/health.js'
import { chatCompletionsRoute } from './routes/chat-completions.js'
import { modelsRoute } from './routes/models.js'
import { adminRoute } from './routes/admin.js'

const env = loadEnv()
const app = new Hono()

// Global middleware
app.use('*', requestId())
app.use('*', logger())
app.use('*', secureHeaders())
app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'anthropic-version'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 86400,
  })
)
app.onError(errorHandler)

// Public routes
app.route('/health', healthRoute)
app.get('/', (c) =>
  c.json({
    name: 'vixproxy',
    version: '0.1.0',
    environment: env.RAILWAY_ENVIRONMENT_NAME ?? env.NODE_ENV,
    commit: env.RAILWAY_GIT_COMMIT_SHA ?? null,
  })
)

// API routes (rate-limited)
app.use('/v1/*', rateLimit({ perMinute: env.RATE_LIMIT_PER_MIN }))
app.route('/v1/chat/completions', chatCompletionsRoute)
app.route('/v1/models', modelsRoute)

// Admin routes
app.route('/admin', adminRoute)

const port = env.PORT
console.log(`[vixproxy] listening on :${port} (${env.NODE_ENV})`)

serve({
  fetch: app.fetch,
  port,
})

// Graceful shutdown
const shutdown = (signal: string) => {
  console.log(`[vixproxy] received ${signal}, shutting down`)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
