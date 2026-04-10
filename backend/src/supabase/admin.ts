/**
 * Supabase admin client for Auth and Storage operations.
 *
 * SECURITY: `service_role` bypasses Row Level Security. NEVER expose this
 * client (or its key) to the browser, and never use the SSR helpers
 * (createServerClient) with the service role — those inject user session
 * cookies that can override the Authorization header.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadEnv } from '../config/env.js'

let cached: SupabaseClient | null = null

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached
  const env = loadEnv()
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  }
  cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })
  return cached
}
