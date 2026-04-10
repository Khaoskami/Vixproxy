import { Hono } from 'hono'
import { loadEnv } from '../config/env.js'

export const healthRoute = new Hono()

healthRoute.get('/', (c) => {
  const env = loadEnv()
  return c.json(
    {
      status: 'healthy',
      service: 'vixproxy',
      deployment: env.RAILWAY_DEPLOYMENT_ID ?? 'local',
      commit: env.RAILWAY_GIT_COMMIT_SHA ?? 'dev',
      timestamp: new Date().toISOString(),
    },
    200
  )
})

healthRoute.get('/live', (c) => c.json({ status: 'alive' }, 200))
healthRoute.get('/ready', (c) => c.json({ status: 'ready' }, 200))
