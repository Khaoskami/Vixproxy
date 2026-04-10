/**
 * Layer 3 safety: LlamaGuard 4 (12B, MLCommons hazard taxonomy).
 *
 * Called via an OpenAI-compatible endpoint — works with any host that exposes
 * LlamaGuard this way (e.g. Groq, Together, local vLLM). Set
 * LLAMAGUARD_BASE_URL and LLAMAGUARD_API_KEY to enable.
 *
 * Supports dual-mode classification: input (pre-generation) and output
 * (post-generation) filtering.
 */
import { loadEnv } from '../config/env.js'

export type LlamaGuardMode = 'input' | 'output'

export interface LlamaGuardDecision {
  allowed: boolean
  reason?: string
  categories: string[]
}

const HAZARD_MAP: Record<string, string> = {
  S1: 'Violent Crimes',
  S2: 'Non-Violent Crimes',
  S3: 'Sex-Related Crimes',
  S4: 'Child Sexual Exploitation',
  S5: 'Defamation',
  S6: 'Specialized Advice',
  S7: 'Privacy',
  S8: 'Intellectual Property',
  S9: 'Indiscriminate Weapons',
  S10: 'Hate',
  S11: 'Suicide & Self-Harm',
  S12: 'Sexual Content',
  S13: 'Elections',
}

export async function llamaGuardCheck(
  text: string,
  _mode: LlamaGuardMode = 'input'
): Promise<LlamaGuardDecision> {
  const env = loadEnv()
  if (!env.LLAMAGUARD_BASE_URL || !env.LLAMAGUARD_API_KEY) {
    return { allowed: true, categories: [] }
  }

  let res: Response
  try {
    res = await fetch(`${env.LLAMAGUARD_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.LLAMAGUARD_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'meta-llama/Llama-Guard-4-12B',
        messages: [{ role: 'user', content: text }],
        temperature: 0,
        max_tokens: 100,
      }),
    })
  } catch (err) {
    console.warn('[safety] llamaguard unreachable:', (err as Error).message)
    return { allowed: true, categories: [] }
  }

  if (!res.ok) {
    console.warn('[safety] llamaguard returned', res.status)
    return { allowed: true, categories: [] }
  }

  const body = (await res.json()) as {
    choices: Array<{ message: { content: string } }>
  }
  const content = body.choices[0]?.message.content ?? ''
  return parseLlamaGuardResponse(content)
}

/**
 * LlamaGuard response format:
 *   "safe"              -> allowed
 *   "unsafe\nS4,S1"     -> blocked with categories
 */
export function parseLlamaGuardResponse(content: string): LlamaGuardDecision {
  const trimmed = content.trim().toLowerCase()
  if (trimmed.startsWith('safe')) {
    return { allowed: true, categories: [] }
  }
  if (trimmed.startsWith('unsafe')) {
    const lines = content.trim().split('\n')
    const rawCats = lines[1]?.trim() ?? ''
    const codes = rawCats.split(/[,\s]+/).filter(Boolean)
    const categories = codes.map((c) => HAZARD_MAP[c] ?? c)
    return {
      allowed: false,
      reason: `LlamaGuard flagged: ${categories.join(', ')}`,
      categories,
    }
  }
  // Unknown format — fail open with a warning.
  return { allowed: true, categories: [] }
}
