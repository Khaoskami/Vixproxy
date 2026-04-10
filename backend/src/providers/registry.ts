/**
 * Provider registry — maps provider name to adapter, and model name to provider.
 *
 * Model routing:
 *   - Explicit prefix: "anthropic/claude-sonnet-4-5" -> anthropic + "claude-sonnet-4-5"
 *   - Prefix lookup table: "gpt-4o-mini" -> openai, "claude-*" -> anthropic, etc.
 */
import { createOpenAICompatibleAdapter } from './openai-compatible.js'
import { anthropicAdapter } from './anthropic.js'
import type { ProviderAdapter, ProviderName } from './types.js'

export const providers: Record<ProviderName, ProviderAdapter> = {
  openai: createOpenAICompatibleAdapter({
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
  }),
  anthropic: anthropicAdapter,
  gemini: createOpenAICompatibleAdapter({
    name: 'gemini',
    // Gemini's OpenAI-compatibility endpoint
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  }),
  openrouter: createOpenAICompatibleAdapter({
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    extraHeaders: {
      'HTTP-Referer': 'https://vixproxy.app',
      'X-Title': 'Vixproxy',
    },
  }),
  deepseek: createOpenAICompatibleAdapter({
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
  }),
  groq: createOpenAICompatibleAdapter({
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
  }),
  cohere: createOpenAICompatibleAdapter({
    name: 'cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
  }),
  mistral: createOpenAICompatibleAdapter({
    name: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
  }),
}

/**
 * Resolve a model string to (provider, provider-specific model).
 *
 * Supports:
 *   1. "provider/model" explicit prefix
 *   2. Known model prefixes (gpt-*, claude-*, gemini-*, etc.)
 */
export function resolveModel(model: string): { provider: ProviderName; model: string } {
  // 1. Explicit provider/model
  const slashIdx = model.indexOf('/')
  if (slashIdx !== -1) {
    const maybeProvider = model.slice(0, slashIdx) as ProviderName
    if (maybeProvider in providers) {
      return { provider: maybeProvider, model: model.slice(slashIdx + 1) }
    }
    // OpenRouter uses "vendor/model" format natively — pass through if unknown.
  }

  // 2. Prefix-based heuristics
  const lower = model.toLowerCase()
  if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('chatgpt-')) {
    return { provider: 'openai', model }
  }
  if (lower.startsWith('claude-')) {
    return { provider: 'anthropic', model }
  }
  if (lower.startsWith('gemini-') || lower.startsWith('models/gemini')) {
    return { provider: 'gemini', model }
  }
  if (lower.startsWith('deepseek-')) {
    return { provider: 'deepseek', model }
  }
  if (
    lower.startsWith('llama-') ||
    lower.startsWith('llama3') ||
    lower.startsWith('mixtral-') ||
    lower.startsWith('gemma-')
  ) {
    // Groq hosts these; OpenRouter can too. Default to Groq.
    return { provider: 'groq', model }
  }
  if (lower.startsWith('command-') || lower.startsWith('c4ai-')) {
    return { provider: 'cohere', model }
  }
  if (lower.startsWith('mistral-') || lower.startsWith('codestral-') || lower.startsWith('pixtral-')) {
    return { provider: 'mistral', model }
  }

  // 3. Fallback — if it looks like vendor/model, route through OpenRouter.
  if (slashIdx !== -1) {
    return { provider: 'openrouter', model }
  }

  throw new Error(
    `Unknown model: "${model}". Use "provider/model" prefix or a recognized model id.`
  )
}

export function getProvider(name: ProviderName): ProviderAdapter {
  const adapter = providers[name]
  if (!adapter) throw new Error(`Unknown provider: ${name}`)
  return adapter
}
