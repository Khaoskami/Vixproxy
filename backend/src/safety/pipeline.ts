/**
 * Multi-layer safety pipeline.
 *
 *   Layer 1: Keyword / regex blocklist   (~microseconds, always on)
 *   Layer 2: OpenAI Moderation API       (~50-200ms, if key configured)
 *   Layer 3: LlamaGuard 4                (~100-500ms, if endpoint configured)
 *   Layer 4: Output filter               (re-run on generated response)
 *
 * Each layer can short-circuit with a block decision. CSAM-category blocks
 * trigger an NCMEC safety-event record (REPORT Act retention).
 */
import { scanKeywords } from './keywords.js'
import { moderateText } from './openai-moderation.js'
import { llamaGuardCheck } from './llamaguard.js'
import { recordSafetyEvent } from './ncmec.js'
import type { ChatCompletionRequest, ChatMessage } from '../providers/types.js'

export type SafetyDecision =
  | 'allowed'
  | 'blocked_keyword'
  | 'blocked_moderation'
  | 'blocked_llamaguard'
  | 'blocked_csam'

export interface SafetyResult {
  decision: SafetyDecision
  categories: string[]
  layer: 'keyword' | 'moderation' | 'llamaguard' | 'output'
  reason?: string
  scores?: Record<string, number>
}

export interface SafetyContext {
  userId: string | null
  requestLogId: string | null
}

function flattenContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

export function flattenMessages(req: ChatCompletionRequest): string {
  return req.messages.map((m) => flattenContent(m.content)).join('\n\n')
}

/**
 * Check an inbound request against all configured safety layers.
 * Returns the first blocking decision, or {decision: 'allowed'}.
 */
export async function checkInput(
  req: ChatCompletionRequest,
  ctx: SafetyContext
): Promise<SafetyResult> {
  const text = flattenMessages(req)

  // Layer 1 — keyword (cheap, always on)
  const kwHits = scanKeywords(text)
  if (kwHits.length > 0) {
    const csamHit = kwHits.find((h) => h.category === 'csam')
    if (csamHit) {
      await recordSafetyEvent({
        userId: ctx.userId,
        requestLogId: ctx.requestLogId,
        layer: 'keyword',
        decision: 'blocked_csam',
        categories: ['csam'],
        content: text,
      })
      return {
        decision: 'blocked_csam',
        categories: ['csam'],
        layer: 'keyword',
        reason: `keyword match: ${csamHit.pattern}`,
      }
    }
    await recordSafetyEvent({
      userId: ctx.userId,
      requestLogId: ctx.requestLogId,
      layer: 'keyword',
      decision: 'blocked_keyword',
      categories: kwHits.map((h) => h.category),
      content: text,
    })
    return {
      decision: 'blocked_keyword',
      categories: kwHits.map((h) => h.category),
      layer: 'keyword',
      reason: `keyword match: ${kwHits[0]?.pattern}`,
    }
  }

  // Layer 2 — OpenAI Moderation
  const mod = await moderateText(text)
  if (!mod.allowed) {
    const isMinors = mod.categories.includes('sexual/minors')
    await recordSafetyEvent({
      userId: ctx.userId,
      requestLogId: ctx.requestLogId,
      layer: 'moderation',
      decision: isMinors ? 'blocked_csam' : 'blocked_moderation',
      categories: mod.categories,
      scores: mod.scores as Record<string, number>,
      content: text,
    })
    return {
      decision: isMinors ? 'blocked_csam' : 'blocked_moderation',
      categories: mod.categories,
      layer: 'moderation',
      reason: mod.reason,
      scores: mod.scores as Record<string, number>,
    }
  }

  // Layer 3 — LlamaGuard
  const lg = await llamaGuardCheck(text, 'input')
  if (!lg.allowed) {
    const isCsam = lg.categories.some((c) => /child/i.test(c))
    await recordSafetyEvent({
      userId: ctx.userId,
      requestLogId: ctx.requestLogId,
      layer: 'llamaguard',
      decision: isCsam ? 'blocked_csam' : 'blocked_llamaguard',
      categories: lg.categories,
      content: text,
    })
    return {
      decision: isCsam ? 'blocked_csam' : 'blocked_llamaguard',
      categories: lg.categories,
      layer: 'llamaguard',
      reason: lg.reason,
    }
  }

  return { decision: 'allowed', categories: [], layer: 'keyword' }
}

/**
 * Check a generated output against keyword + LlamaGuard (output mode).
 * Skips OpenAI moderation to halve cost for generation-heavy workloads;
 * enable it if you need defense-in-depth against jailbroken outputs.
 */
export async function checkOutput(
  output: string,
  ctx: SafetyContext
): Promise<SafetyResult> {
  const kwHits = scanKeywords(output)
  if (kwHits.some((h) => h.category === 'csam')) {
    await recordSafetyEvent({
      userId: ctx.userId,
      requestLogId: ctx.requestLogId,
      layer: 'output',
      decision: 'blocked_csam',
      categories: ['csam'],
      content: output,
    })
    return {
      decision: 'blocked_csam',
      categories: ['csam'],
      layer: 'output',
      reason: 'output keyword match',
    }
  }

  const lg = await llamaGuardCheck(output, 'output')
  if (!lg.allowed) {
    const isCsam = lg.categories.some((c) => /child/i.test(c))
    await recordSafetyEvent({
      userId: ctx.userId,
      requestLogId: ctx.requestLogId,
      layer: 'output',
      decision: isCsam ? 'blocked_csam' : 'blocked_llamaguard',
      categories: lg.categories,
      content: output,
    })
    return {
      decision: isCsam ? 'blocked_csam' : 'blocked_llamaguard',
      categories: lg.categories,
      layer: 'output',
      reason: lg.reason,
    }
  }

  return { decision: 'allowed', categories: [], layer: 'output' }
}
