/**
 * OpenAI-compatible adapter.
 *
 * Six of eight target providers accept the exact OpenAI chat-completions wire
 * format. The only things that change per-provider are:
 *   - base URL
 *   - authorization header (almost always `Authorization: Bearer <key>`)
 *   - any required extra headers
 *   - model id format
 *
 * This adapter is a thin fetch wrapper; the per-provider subclasses below
 * just configure those fields.
 */
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionStreamChunk,
  ProviderAdapter,
  ProviderContext,
  ProviderName,
} from './types.js'
import { ProviderError } from './types.js'
import { parseSSEStream } from './sse.js'

export interface OpenAICompatibleConfig {
  name: ProviderName
  baseUrl: string
  /** Optional header transform — default uses Authorization: Bearer. */
  authHeaders?: (apiKey: string) => Record<string, string>
  /** Optional extra headers always included (e.g. `anthropic-version`). */
  extraHeaders?: Record<string, string>
  /** Hook to mutate the request body just before sending. */
  transformRequest?: (req: ChatCompletionRequest) => ChatCompletionRequest
  /** Hook to mutate the parsed response before returning. */
  transformResponse?: (res: ChatCompletionResponse) => ChatCompletionResponse
}

export function createOpenAICompatibleAdapter(config: OpenAICompatibleConfig): ProviderAdapter {
  const buildHeaders = (apiKey: string): Record<string, string> => {
    const base: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(config.extraHeaders ?? {}),
    }
    if (config.authHeaders) {
      Object.assign(base, config.authHeaders(apiKey))
    } else {
      base.authorization = `Bearer ${apiKey}`
    }
    return base
  }

  async function complete(
    req: ChatCompletionRequest,
    ctx: ProviderContext
  ): Promise<ChatCompletionResponse> {
    const body = config.transformRequest?.(req) ?? req
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 120_000)
    let res: Response
    try {
      res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(ctx.apiKey),
        body: JSON.stringify({ ...body, model: ctx.model, stream: false }),
        signal: controller.signal,
      })
    } catch (err) {
      throw new ProviderError({
        provider: config.name,
        status: 502,
        code: 'upstream_unreachable',
        message: `Failed to reach ${config.name}: ${(err as Error).message}`,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      const text = await safeText(res)
      throw new ProviderError({
        provider: config.name,
        status: res.status,
        code: `upstream_${res.status}`,
        message: `${config.name} returned ${res.status}`,
        upstreamBody: tryJson(text),
      })
    }

    const json = (await res.json()) as ChatCompletionResponse
    return config.transformResponse?.(json) ?? json
  }

  async function* stream(
    req: ChatCompletionRequest,
    ctx: ProviderContext
  ): AsyncIterable<ChatCompletionStreamChunk> {
    const body = config.transformRequest?.(req) ?? req
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 300_000)
    let res: Response
    try {
      res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...buildHeaders(ctx.apiKey), accept: 'text/event-stream' },
        body: JSON.stringify({ ...body, model: ctx.model, stream: true }),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      throw new ProviderError({
        provider: config.name,
        status: 502,
        code: 'upstream_unreachable',
        message: `Failed to reach ${config.name}: ${(err as Error).message}`,
      })
    }

    if (!res.ok || !res.body) {
      clearTimeout(timer)
      const text = await safeText(res)
      throw new ProviderError({
        provider: config.name,
        status: res.status,
        code: `upstream_${res.status}`,
        message: `${config.name} stream returned ${res.status}`,
        upstreamBody: tryJson(text),
      })
    }

    try {
      for await (const event of parseSSEStream(res.body)) {
        if (event.data === '[DONE]') return
        if (!event.data) continue
        try {
          const parsed = JSON.parse(event.data) as ChatCompletionStreamChunk
          yield parsed
        } catch {
          // Ignore non-JSON SSE comments
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return { name: config.name, complete, stream }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
