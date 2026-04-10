import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { loadEnv } from '../config/env.js'
import * as schema from './schema.js'

let cached: ReturnType<typeof drizzle<typeof schema>> | null = null
let rawClient: ReturnType<typeof postgres> | null = null

/**
 * Drizzle client pointing at Supabase.
 *
 * Use one of:
 *   - Direct connection (IPv6 only)     postgres://postgres:PW@db.REF.supabase.co:5432/postgres
 *   - Shared pooler — session (IPv4)    postgres://postgres.REF:PW@aws-0-REGION.pooler.supabase.com:5432/postgres
 *   - Shared pooler — transaction       postgres://postgres.REF:PW@aws-0-REGION.pooler.supabase.com:6543/postgres
 *
 * If you use the TRANSACTION pooler (port 6543) you MUST set `prepare: false`
 * because prepared statements are not supported in that mode.
 */
export function getDb() {
  if (cached) return cached
  const env = loadEnv()
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set')
  }

  const isTransactionPooler = env.DATABASE_URL.includes(':6543')
  rawClient = postgres(env.DATABASE_URL, {
    max: isTransactionPooler ? 1 : 10,
    prepare: !isTransactionPooler,
    idle_timeout: 20,
    connect_timeout: 10,
  })
  cached = drizzle(rawClient, { schema })
  return cached
}

export async function closeDb(): Promise<void> {
  if (rawClient) {
    await rawClient.end({ timeout: 5 })
    rawClient = null
    cached = null
  }
}

export { schema }
