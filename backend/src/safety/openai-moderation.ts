/**
 * Layer 2 safety: OpenAI Moderation API (free tier, built on GPT-4o).
 *
 * Uses `omni-moderation-latest` which returns 11 categories including the
 * critical `sexual/minors`. Supports multi-modal inputs.
 *
 * For CSAM detection we treat `sexual/minors` with a very low threshold —
 * the cost of a false negative vastly outweighs a false positive.
 */
import { loadEnv } from '../config/env.js'

export type ModerationCategory =
  | 'sexual'
  | 'sexual/minors'
  | 'harassment'
  | 'harassment/threatening'
  | 'hate'
  | 'hate/threatening'
  | 'illicit'
  | 'illicit/violent'
  | 'self-harm'
  | 'self-harm/intent'
  | 'self-harm/instructions'
  | 'violence'
  | 'violence/graphic'

export interface ModerationResult {
  flagged: boolean
  categories: Partial<Record<ModerationCategory, boolean>>
  category_scores: Partial<Record<ModerationCategory, number>>
}

export interface ModerationDecision {
  allowed: boolean
  reason?: string
  categories: ModerationCategory[]
  scores: Partial<Record<ModerationCategory, number>>
  sexualMinorsScore: number
}

/**
 * Call OpenAI Moderation API on free text input.
 *
 * If no OPENAI_MODERATION_API_KEY / OPENAI_API_KEY is configured, returns a
 * permissive result so dev environments work without the external dep. In
 * production, always configure a key.
 */
export async function moderateText(input: string): Promise<ModerationDecision> {
  const env = loadEnv()
  const apiKey = env.OPENAI_MODERATION_API_KEY ?? env.OPENAI_API_KEY
  if (!apiKey) {
    return {
      allowed: true,
      categories: [],
      scores: {},
      sexualMinorsScore: 0,
    }
  }

  let res: Response
  try {
    res = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'omni-moderation-latest',
        input,
      }),
    })
  } catch (err) {
    // Fail OPEN for availability — but log. This is a judgment call; if your
    // threat model demands fail-closed, throw here instead.
    console.warn('[safety] moderation API unreachable:', (err as Error).message)
    return { allowed: true, categories: [], scores: {}, sexualMinorsScore: 0 }
  }

  if (!res.ok) {
    console.warn('[safety] moderation API returned', res.status)
    return { allowed: true, categories: [], scores: {}, sexualMinorsScore: 0 }
  }

  const body = (await res.json()) as { results: ModerationResult[] }
  const result = body.results[0]
  if (!result) {
    return { allowed: true, categories: [], scores: {}, sexualMinorsScore: 0 }
  }

  const flagged = Object.entries(result.categories)
    .filter(([, v]) => v === true)
    .map(([k]) => k as ModerationCategory)

  const sexualMinorsScore = result.category_scores['sexual/minors'] ?? 0
  const threshold = env.SAFETY_SEXUAL_MINORS_THRESHOLD

  // Asymmetric threshold: block well below default flagging for sexual/minors.
  if (sexualMinorsScore >= threshold) {
    return {
      allowed: false,
      reason: `sexual/minors score ${sexualMinorsScore.toFixed(3)} >= threshold ${threshold}`,
      categories: ['sexual/minors', ...flagged.filter((c) => c !== 'sexual/minors')],
      scores: result.category_scores,
      sexualMinorsScore,
    }
  }

  if (result.flagged) {
    return {
      allowed: false,
      reason: `moderation categories flagged: ${flagged.join(', ')}`,
      categories: flagged,
      scores: result.category_scores,
      sexualMinorsScore,
    }
  }

  return {
    allowed: true,
    categories: [],
    scores: result.category_scores,
    sexualMinorsScore,
  }
}
