import { getDb } from '../db/client.js'
import { requestLogs, type NewRequestLog } from '../db/schema.js'
import type { ProviderName } from '../providers/types.js'

export interface LogRequestInput {
  userId: string
  proxyKeyId?: string
  provider: ProviderName
  model: string
  requestId: string
  statusCode: number
  promptHash?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  costMicroUsd?: number
  latencyMs: number
  safetyDecision: NewRequestLog['safetyDecision']
  safetyCategories?: string[]
}

/**
 * Persist a request log row. Best-effort — never throws, never blocks the
 * user's response. On dev (no DB) this is a no-op warning.
 */
export async function logRequest(input: LogRequestInput): Promise<void> {
  if (!process.env.DATABASE_URL) {
    // dev: quiet unless something is wrong
    return
  }
  if (input.userId.startsWith('dev_')) return
  try {
    const db = getDb()
    await db.insert(requestLogs).values({
      userId: input.userId,
      proxyKeyId: input.proxyKeyId,
      provider: input.provider,
      model: input.model,
      requestId: input.requestId,
      statusCode: input.statusCode,
      promptHash: input.promptHash,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      totalTokens: input.totalTokens,
      costMicroUsd: input.costMicroUsd,
      latencyMs: input.latencyMs,
      safetyDecision: input.safetyDecision,
      safetyCategories: input.safetyCategories,
    })
  } catch (err) {
    console.warn('[request-log] failed to persist:', (err as Error).message)
  }
}
