/**
 * Canonical OpenAI-compatible chat completion types used across all providers.
 * Non-OpenAI providers are translated in/out of these shapes.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: Role
  content: string | ContentPart[]
  name?: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  top_p?: number
  n?: number
  stream?: boolean
  stop?: string | string[]
  max_tokens?: number
  presence_penalty?: number
  frequency_penalty?: number
  user?: string
  tools?: Array<{
    type: 'function'
    function: { name: string; description?: string; parameters?: Record<string, unknown> }
  }>
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  response_format?: { type: 'text' | 'json_object' | 'json_schema'; json_schema?: unknown }
}

export interface ChatCompletionChoice {
  index: number
  message: ChatMessage
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
}

export interface ChatCompletionUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage?: ChatCompletionUsage
  system_fingerprint?: string
}

export interface ChatCompletionStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: Partial<ChatMessage>
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  }>
}

export type ProviderName =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'deepseek'
  | 'groq'
  | 'cohere'
  | 'mistral'

export interface ProviderAdapter {
  name: ProviderName
  /** Forward a non-streaming request and return a canonical response. */
  complete(req: ChatCompletionRequest, ctx: ProviderContext): Promise<ChatCompletionResponse>
  /** Forward a streaming request; yields OpenAI-format chunks. */
  stream(
    req: ChatCompletionRequest,
    ctx: ProviderContext
  ): AsyncIterable<ChatCompletionStreamChunk>
}

export interface ProviderContext {
  apiKey: string
  /** The provider-specific model id (after stripping any "provider/" prefix). */
  model: string
  /** Opaque request id for tracing/logging. */
  requestId: string
  /** Upstream fetch timeout, milliseconds. */
  timeoutMs?: number
}

export class ProviderError extends Error {
  status: number
  code: string
  provider: ProviderName
  upstreamBody?: unknown
  constructor(opts: {
    message: string
    status: number
    code: string
    provider: ProviderName
    upstreamBody?: unknown
  }) {
    super(opts.message)
    this.name = 'ProviderError'
    this.status = opts.status
    this.code = opts.code
    this.provider = opts.provider
    this.upstreamBody = opts.upstreamBody
  }
}
