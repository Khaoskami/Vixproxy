import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z
    .string()
    .default('3000')
    .transform((v) => parseInt(v, 10)),

  // Database
  DATABASE_URL: z.string().url().optional(),

  // Supabase
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),

  // Master encryption key for API-key-at-rest (AES-256-GCM).
  // 64-char hex (32 bytes). Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  MASTER_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'MASTER_ENCRYPTION_KEY must be 64 hex chars (32 bytes)')
    .optional(),
  // Optional: map of version numbers to hex keys (JSON) for rotation.
  // {"1":"<hex>","2":"<hex>"}  — highest version is used for new encryptions.
  ENCRYPTION_KEY_RING: z.string().optional(),

  // Provider keys used as fallback when a user has not set their own key
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),

  // Safety
  OPENAI_MODERATION_API_KEY: z.string().optional(),
  LLAMAGUARD_BASE_URL: z.string().url().optional(),
  LLAMAGUARD_API_KEY: z.string().optional(),
  SAFETY_SEXUAL_MINORS_THRESHOLD: z
    .string()
    .default('0.1')
    .transform((v) => parseFloat(v)),

  // NCMEC (CyberTipline)
  NCMEC_ESP_ID: z.string().optional(),
  NCMEC_API_USERNAME: z.string().optional(),
  NCMEC_API_PASSWORD: z.string().optional(),
  NCMEC_REPORTING_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // Rate limiting
  RATE_LIMIT_PER_MIN: z
    .string()
    .default('60')
    .transform((v) => parseInt(v, 10)),

  // Railway-injected (read-only, informational)
  RAILWAY_ENVIRONMENT_NAME: z.string().optional(),
  RAILWAY_SERVICE_NAME: z.string().optional(),
  RAILWAY_DEPLOYMENT_ID: z.string().optional(),
  RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  RAILWAY_PRIVATE_DOMAIN: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | null = null

export function loadEnv(): Env {
  if (cached) return cached
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error('[env] invalid environment:', parsed.error.flatten().fieldErrors)
    throw new Error('Invalid environment configuration')
  }
  cached = parsed.data
  return cached
}
