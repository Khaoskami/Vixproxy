import { Hono } from 'hono'
import { proxyKeyAuth } from '../middleware/auth.js'

export const modelsRoute = new Hono()

modelsRoute.use('*', proxyKeyAuth())

/**
 * OpenAI-compatible /v1/models listing. Returns the canonical model ids this
 * proxy knows how to route. Clients can use any of these directly, or use a
 * `provider/model` form to override routing.
 */
const CURATED_MODELS = [
  // OpenAI
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'o1-preview',
  'o3-mini',
  // Anthropic
  'claude-opus-4-6',
  'claude-sonnet-4-5',
  'claude-3-5-haiku-latest',
  // Gemini
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  // DeepSeek
  'deepseek-chat',
  'deepseek-reasoner',
  // Groq (Llama, Mixtral)
  'llama-3.3-70b-versatile',
  'mixtral-8x7b-32768',
  // Cohere
  'command-r-plus',
  'command-r',
  // Mistral
  'mistral-large-latest',
  'codestral-latest',
]

modelsRoute.get('/', (c) => {
  return c.json({
    object: 'list',
    data: CURATED_MODELS.map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'vixproxy',
    })),
  })
})
