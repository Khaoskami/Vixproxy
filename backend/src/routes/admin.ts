import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { providerKeys, proxyApiKeys } from '../db/schema.js'
import { storeProviderKey } from '../services/provider-keys.js'
import { generateProxyKey } from '../middleware/auth.js'
import { getSupabaseAdmin } from '../supabase/admin.js'

export const adminRoute = new Hono()

/**
 * Admin routes use Supabase Auth JWTs (user-facing) rather than proxy keys.
 * The bearer token is verified via the service-role client, and the resulting
 * Supabase user id is used as the userId for all operations.
 */
async function requireSupabaseUser(c: Context): Promise<string> {
  const auth = c.req.header('authorization')
  const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) throw new HTTPException(401, { message: 'Missing Supabase JWT' })

  try {
    const admin = getSupabaseAdmin()
    const { data, error } = await admin.auth.getUser(token)
    if (error || !data.user) {
      throw new HTTPException(401, { message: 'Invalid Supabase session' })
    }
    return data.user.id
  } catch (err) {
    if (err instanceof HTTPException) throw err
    throw new HTTPException(503, { message: 'Supabase not configured' })
  }
}

// ---- Provider keys ----

const storeKeySchema = z.object({
  provider: z.enum([
    'openai',
    'anthropic',
    'gemini',
    'openrouter',
    'deepseek',
    'groq',
    'cohere',
    'mistral',
  ]),
  api_key: z.string().min(10),
  label: z.string().optional(),
})

adminRoute.post('/provider-keys', async (c) => {
  const userId = await requireSupabaseUser(c)
  const parsed = storeKeySchema.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid body' })
  }
  const row = await storeProviderKey({
    userId,
    provider: parsed.data.provider,
    plaintextKey: parsed.data.api_key,
    label: parsed.data.label,
  })
  return c.json({
    id: row.id,
    provider: row.provider,
    label: row.label,
    last4: row.last4,
    created_at: row.createdAt,
  })
})

adminRoute.get('/provider-keys', async (c) => {
  const userId = await requireSupabaseUser(c)
  const db = getDb()
  const rows = await db
    .select({
      id: providerKeys.id,
      provider: providerKeys.provider,
      label: providerKeys.label,
      last4: providerKeys.last4,
      createdAt: providerKeys.createdAt,
      lastUsedAt: providerKeys.lastUsedAt,
      disabled: providerKeys.disabled,
    })
    .from(providerKeys)
    .where(eq(providerKeys.userId, userId))
  return c.json({ data: rows })
})

adminRoute.delete('/provider-keys/:id', async (c) => {
  const userId = await requireSupabaseUser(c)
  const id = c.req.param('id')
  const db = getDb()
  const rows = await db
    .delete(providerKeys)
    .where(and(eq(providerKeys.id, id), eq(providerKeys.userId, userId)))
    .returning({ id: providerKeys.id })
  if (!rows[0]) {
    throw new HTTPException(404, { message: 'Not found' })
  }
  return c.json({ deleted: id })
})

// ---- Proxy API keys ----

const createProxyKeySchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.string()).optional(),
  expires_at: z.string().datetime().optional(),
})

adminRoute.post('/proxy-keys', async (c) => {
  const userId = await requireSupabaseUser(c)
  const parsed = createProxyKeySchema.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid body' })
  }
  const { raw, hash, prefix } = generateProxyKey()
  const db = getDb()
  const [row] = await db
    .insert(proxyApiKeys)
    .values({
      userId,
      name: parsed.data.name,
      keyHash: hash,
      keyPrefix: prefix,
      scopes: parsed.data.scopes ?? [],
      expiresAt: parsed.data.expires_at ? new Date(parsed.data.expires_at) : undefined,
    })
    .returning()
  if (!row) throw new HTTPException(500, { message: 'Insert failed' })
  // Return the plaintext ONCE — never again.
  return c.json({
    id: row.id,
    name: row.name,
    key: raw,
    prefix: row.keyPrefix,
    scopes: row.scopes,
    created_at: row.createdAt,
  })
})

adminRoute.get('/proxy-keys', async (c) => {
  const userId = await requireSupabaseUser(c)
  const db = getDb()
  const rows = await db
    .select({
      id: proxyApiKeys.id,
      name: proxyApiKeys.name,
      prefix: proxyApiKeys.keyPrefix,
      scopes: proxyApiKeys.scopes,
      createdAt: proxyApiKeys.createdAt,
      lastUsedAt: proxyApiKeys.lastUsedAt,
      expiresAt: proxyApiKeys.expiresAt,
      revokedAt: proxyApiKeys.revokedAt,
    })
    .from(proxyApiKeys)
    .where(eq(proxyApiKeys.userId, userId))
  return c.json({ data: rows })
})

adminRoute.post('/proxy-keys/:id/revoke', async (c) => {
  const userId = await requireSupabaseUser(c)
  const id = c.req.param('id')
  const db = getDb()
  const rows = await db
    .update(proxyApiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(proxyApiKeys.id, id), eq(proxyApiKeys.userId, userId)))
    .returning({ id: proxyApiKeys.id })
  if (!rows[0]) {
    throw new HTTPException(404, { message: 'Not found' })
  }
  return c.json({ revoked: id })
})
