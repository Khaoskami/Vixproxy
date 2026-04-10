import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  index,
  pgEnum,
  bigint,
} from 'drizzle-orm/pg-core'

export const providerEnum = pgEnum('provider', [
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'deepseek',
  'groq',
  'cohere',
  'mistral',
])

export const safetyDecisionEnum = pgEnum('safety_decision', [
  'allowed',
  'blocked_keyword',
  'blocked_moderation',
  'blocked_llamaguard',
  'blocked_csam',
])

/** Users / tenants — authenticated via Supabase Auth. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Matches Supabase Auth user id when integrated.
  authUserId: uuid('auth_user_id').unique(),
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  role: text('role').notNull().default('user'), // 'user' | 'admin'
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Per-user provider API keys, stored encrypted at rest with AES-256-GCM.
 * `encrypted_key` is the base64 version || iv || ciphertext || authTag blob.
 */
export const providerKeys = pgTable(
  'provider_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: providerEnum('provider').notNull(),
    label: text('label'),
    encryptedKey: text('encrypted_key').notNull(),
    keyVersion: integer('key_version').notNull(),
    last4: text('last4'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    disabled: boolean('disabled').notNull().default(false),
  },
  (t) => ({
    userProviderIdx: index('provider_keys_user_provider_idx').on(t.userId, t.provider),
  })
)

/**
 * Vixproxy API keys (scoped credentials clients use to hit /v1/*).
 * Only the hash is stored — the plaintext is shown once at creation.
 */
export const proxyApiKeys = pgTable(
  'proxy_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // sha256 hex of the raw key (constant-time compared).
    keyHash: text('key_hash').notNull().unique(),
    keyPrefix: text('key_prefix').notNull(), // e.g. "vx_live_abcd" for display
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    keyHashIdx: index('proxy_api_keys_key_hash_idx').on(t.keyHash),
    userIdx: index('proxy_api_keys_user_idx').on(t.userId),
  })
)

/**
 * Request audit log — one row per /v1/chat/completions request.
 * NEVER store the actual prompt/completion text if the request was flagged for
 * CSAM. Doing so could constitute possession. Only store metadata + hash.
 */
export const requestLogs = pgTable(
  'request_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    proxyKeyId: uuid('proxy_key_id').references(() => proxyApiKeys.id, { onDelete: 'set null' }),
    provider: providerEnum('provider').notNull(),
    model: text('model').notNull(),
    requestId: text('request_id').notNull(),
    // Token counts from the upstream provider, if available.
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    // Estimated cost in micro-dollars (1 USD = 1_000_000).
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }),
    latencyMs: integer('latency_ms'),
    statusCode: integer('status_code').notNull(),
    // Opaque sha256 of the prompt — for dedup / rate limiting only.
    promptHash: text('prompt_hash'),
    safetyDecision: safetyDecisionEnum('safety_decision').notNull().default('allowed'),
    safetyCategories: jsonb('safety_categories').$type<string[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('request_logs_user_created_idx').on(t.userId, t.createdAt),
    createdIdx: index('request_logs_created_idx').on(t.createdAt),
    safetyIdx: index('request_logs_safety_idx').on(t.safetyDecision),
  })
)

/**
 * Safety events — kept separately for compliance audit. For CSAM events, we
 * record classifier scores and metadata but NEVER the prompt text.
 * REPORT Act requires retention of CyberTipline-related data for 1 year.
 */
export const safetyEvents = pgTable(
  'safety_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestLogId: uuid('request_log_id').references(() => requestLogs.id, {
      onDelete: 'set null',
    }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    decision: safetyDecisionEnum('decision').notNull(),
    categories: jsonb('categories').$type<string[]>().notNull(),
    scores: jsonb('scores').$type<Record<string, number>>(),
    // Layer that triggered the block: 'keyword' | 'moderation' | 'llamaguard' | 'output'
    layer: text('layer').notNull(),
    // Opaque content hash only — never plaintext.
    contentHash: text('content_hash').notNull(),
    reportedToNcmec: boolean('reported_to_ncmec').notNull().default(false),
    ncmecReportId: text('ncmec_report_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Retention: REPORT Act (18 USC 2258A) requires ≥1 year for CTL data.
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (t) => ({
    createdIdx: index('safety_events_created_idx').on(t.createdAt),
    retainIdx: index('safety_events_retain_idx').on(t.retainUntil),
    ncmecIdx: index('safety_events_ncmec_idx').on(t.reportedToNcmec),
  })
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type ProviderKey = typeof providerKeys.$inferSelect
export type NewProviderKey = typeof providerKeys.$inferInsert
export type ProxyApiKey = typeof proxyApiKeys.$inferSelect
export type NewProxyApiKey = typeof proxyApiKeys.$inferInsert
export type RequestLog = typeof requestLogs.$inferSelect
export type NewRequestLog = typeof requestLogs.$inferInsert
export type SafetyEvent = typeof safetyEvents.$inferSelect
export type NewSafetyEvent = typeof safetyEvents.$inferInsert
