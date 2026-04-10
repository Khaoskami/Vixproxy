/**
 * Anthropic adapter — translates OpenAI chat-completions format to Anthropic's
 * /v1/messages endpoint and back.
 *
 * Differences from OpenAI:
 *   - Auth: `x-api-key` (not `Authorization: Bearer`)
 *   - Required header: `anthropic-version: 2023-06-01`
 *   - System prompt is a top-level `system` parameter, NOT a message
 *   - `max_tokens` is REQUIRED
 *   - Response: `content` array (no `choices` wrapper), elements are
 *     `{type: "text", text: "..."}`
 *   - Streaming uses event types: message_start, content_block_start,
 *     content_block_delta, content_block_stop, message_delta, message_stop
 */
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionStreamChunk,
  ChatMessage,
  ContentPart,
  ProviderAdapter,
  ProviderContext,
} from './types.js'
import { ProviderError } from './types.js'
import { parseSSEStream } from './sse.js'

const ANTHROPIC_BASE = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string
  max_tokens: number
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>
}

interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: Array<{ type: string; text?: string }>
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
  stop_sequence: string | null
  usage: { input_tokens: number; output_tokens: number }
}

/** Extract system text and remap messages. */
function toAnthropicRequest(req: ChatCompletionRequest, model: string): AnthropicRequest {
  let system: string | undefined
  const messages: AnthropicMessage[] = []

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      const text = contentToString(msg.content)
      system = system ? `${system}\n\n${text}` : text
      continue
    }
    if (msg.role === 'tool') {
      // Attach as tool_result inside a user message
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id ?? '',
            content: contentToString(msg.content),
          },
        ],
      })
      continue
    }
    if (msg.role === 'assistant' || msg.role === 'user') {
      messages.push({
        role: msg.role,
        content: toAnthropicContent(msg.content),
      })
    }
  }

  const out: AnthropicRequest = {
    model,
    messages,
    max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
  }
  if (system) out.system = system
  if (req.temperature !== undefined) out.temperature = req.temperature
  if (req.top_p !== undefined) out.top_p = req.top_p
  if (req.stop) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop]
  if (req.tools) {
    out.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: (t.function.parameters ?? {}) as Record<string, unknown>,
    }))
  }
  return out
}

function contentToString(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function toAnthropicContent(content: ChatMessage['content']): string | AnthropicContentBlock[] {
  if (typeof content === 'string') return content
  const out: AnthropicContentBlock[] = []
  for (const part of content as ContentPart[]) {
    if (part.type === 'text') {
      out.push({ type: 'text', text: part.text })
    } else if (part.type === 'image_url') {
      // Only base64 data URLs supported for Anthropic here.
      const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        out.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1]!, data: match[2]! },
        })
      }
    }
  }
  return out
}

function toOpenAIResponse(res: AnthropicResponse, requestedModel: string): ChatCompletionResponse {
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')

  return {
    id: res.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: mapStopReason(res.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: res.usage.input_tokens,
      completion_tokens: res.usage.output_tokens,
      total_tokens: res.usage.input_tokens + res.usage.output_tokens,
    },
  }
}

function mapStopReason(
  r: AnthropicResponse['stop_reason']
): ChatCompletionResponse['choices'][0]['finish_reason'] {
  switch (r) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    default:
      return null
  }
}

export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',

  async complete(req, ctx): Promise<ChatCompletionResponse> {
    const body = toAnthropicRequest(req, ctx.model)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 120_000)
    let res: Response
    try {
      res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ctx.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({ ...body, stream: false }),
        signal: controller.signal,
      })
    } catch (err) {
      throw new ProviderError({
        provider: 'anthropic',
        status: 502,
        code: 'upstream_unreachable',
        message: `Failed to reach Anthropic: ${(err as Error).message}`,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProviderError({
        provider: 'anthropic',
        status: res.status,
        code: `upstream_${res.status}`,
        message: `Anthropic returned ${res.status}`,
        upstreamBody: tryJson(text),
      })
    }

    const json = (await res.json()) as AnthropicResponse
    return toOpenAIResponse(json, req.model)
  },

  async *stream(req, ctx): AsyncIterable<ChatCompletionStreamChunk> {
    const body = toAnthropicRequest(req, ctx.model)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 300_000)
    let res: Response
    try {
      res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-api-key': ctx.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      throw new ProviderError({
        provider: 'anthropic',
        status: 502,
        code: 'upstream_unreachable',
        message: `Failed to reach Anthropic: ${(err as Error).message}`,
      })
    }

    if (!res.ok || !res.body) {
      clearTimeout(timer)
      const text = await res.text().catch(() => '')
      throw new ProviderError({
        provider: 'anthropic',
        status: res.status,
        code: `upstream_${res.status}`,
        message: `Anthropic stream returned ${res.status}`,
        upstreamBody: tryJson(text),
      })
    }

    const createdAt = Math.floor(Date.now() / 1000)
    let messageId = `msg_${ctx.requestId}`
    let stopReason: AnthropicResponse['stop_reason'] = null

    try {
      for await (const event of parseSSEStream(res.body)) {
        if (!event.data) continue
        let data: Record<string, unknown>
        try {
          data = JSON.parse(event.data)
        } catch {
          continue
        }

        switch (event.event) {
          case 'message_start': {
            const msg = (data as { message?: { id?: string } }).message
            if (msg?.id) messageId = msg.id
            yield {
              id: messageId,
              object: 'chat.completion.chunk',
              created: createdAt,
              model: req.model,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
            }
            break
          }
          case 'content_block_delta': {
            const delta = (data as { delta?: { type?: string; text?: string } }).delta
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              yield {
                id: messageId,
                object: 'chat.completion.chunk',
                created: createdAt,
                model: req.model,
                choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
              }
            }
            break
          }
          case 'message_delta': {
            const d = (data as { delta?: { stop_reason?: AnthropicResponse['stop_reason'] } }).delta
            if (d?.stop_reason) stopReason = d.stop_reason
            break
          }
          case 'message_stop': {
            yield {
              id: messageId,
              object: 'chat.completion.chunk',
              created: createdAt,
              model: req.model,
              choices: [{ index: 0, delta: {}, finish_reason: mapStopReason(stopReason) }],
            }
            return
          }
        }
      }
    } finally {
      clearTimeout(timer)
    }
  },
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
