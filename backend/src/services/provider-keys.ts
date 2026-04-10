/**
 * Resolves a user's upstream provider API key.
 *
 * Preference order:
 *   1. User's encrypted per-provider key (decrypted from DB)
 *   2. Server-wide fallback from env (for dev / shared-key deployments)
 *   3. Throws — caller handles 401
 */
import { and, eq } from 'drizzle-orm'
import { decrypt, encrypt } from '../crypto/aes-gcm.js'
import { getDb } from '../db/client.js'
import { providerKeys, type ProviderKey } from '../db/schema.js'
import { loadEnv } from '../config/env.js'
import type { ProviderName } from '../providers/types.js'

const ENV_FALLBACK: Record<ProviderName, keyof ReturnType<typeof loadEnv>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  groq: 'GROQ_API_KEY',
  cohere: 'COHERE_API_KEY',
  mistral: 'MISTRAL_API_KEY',
}

export async function resolveUpstreamKey(
  userId: string,
  provider: ProviderName
): Promise<string> {
  // 1. User-owned key
  if (process.env.DATABASE_URL && !userId.startsWith('dev_')) {
    const db = getDb()
    const rows = await db
      .select()
      .from(providerKeys)
      .where(
        and(
          eq(providerKeys.userId, userId),
          eq(providerKeys.provider, provider),
          eq(providerKeys.disabled, false)
        )
      )
      .limit(1)

    const row = rows[0]
    if (row) {
      // Opportunistic last-used bump
      await db
        .update(providerKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(providerKeys.id, row.id))
      return decrypt(row.encryptedKey)
    }
  }

  // 2. Env fallback
  const env = loadEnv()
  const envKey = ENV_FALLBACK[provider]
  const value = env[envKey] as string | undefined
  if (value && value.length > 0) {
    return value
  }

  throw new Error(`No API key available for provider "${provider}"`)
}

/** Store a new encrypted provider key for a user. */
export async function storeProviderKey(input: {
  userId: string
  provider: ProviderName
  plaintextKey: string
  label?: string
}): Promise<ProviderKey> {
  const db = getDb()
  const encryptedKey = encrypt(input.plaintextKey)
  const keyVersion = Buffer.from(encryptedKey, 'base64')[0] ?? 1
  const last4 = input.plaintextKey.slice(-4)
  const [row] = await db
    .insert(providerKeys)
    .values({
      userId: input.userId,
      provider: input.provider,
      encryptedKey,
      keyVersion,
      label: input.label,
      last4,
    })
    .returning()
  if (!row) throw new Error('Failed to insert provider key')
  return row
}
