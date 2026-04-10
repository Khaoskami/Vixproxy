import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { loadEnv } from '../config/env.js'

async function main() {
  const env = loadEnv()
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL not set; skipping migrations')
    process.exit(0)
  }

  const client = postgres(env.DATABASE_URL, { max: 1, prepare: false })
  const db = drizzle(client)

  console.log('[migrate] running migrations from ./drizzle')
  await migrate(db, { migrationsFolder: './drizzle' })
  console.log('[migrate] complete')
  await client.end()
  process.exit(0)
}

main().catch((err) => {
  console.error('[migrate] failed:', err)
  process.exit(1)
})
