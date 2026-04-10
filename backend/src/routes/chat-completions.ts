import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { streamSSE } from 'hono/streaming'
import crypto from 'node:crypto'
import { z } from 'zod'
import { proxyKeyAuth } from '../middleware/auth.js'
import { resolveModel, getProvider } from '../providers/registry.js'
import { checkInput, checkOutput } from '../safety/pipeline.js'
import { loadEnv } from '../config/env.js'
import { resolveUpstreamKey } from '../services/provider-keys.js'
import { logRequest } from '../services/request-log.js'
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
} from '../providers/types.js'

export const chatCompletionsRoute = new Hono()

const messageSchema: z.ZodType<ChatMessage> = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([
    z.string(),
    z.array(
      z.union([
        z.object({ type: z.literal('text'), text: z.string() }),
        z.object({
          type: z.literal('image_url'),
          image_url: z.object({
            url: z.string(),
            detail: z.enum(['low', 'high', 'auto']).optional(),
          }),
        }),
      ])
    ),
  ]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
})

const requestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.number().int().positive().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  user: z.string().optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  response_format: z.any().optional(),
})

chatCompletionsRoute.use('*', proxyKeyAuth())

chatCompletionsRoute.post('/', async (c) => {
  const requestId = c.get('requestId') as string
  const userId = c.get('userId') as string
  const proxyKeyId = c.get('proxyKeyId') as string | undefined
  const startedAt = Date.now()

  // 1. Parse and validate
  let body: ChatCompletionRequest
  try {
    const parsed = requestSchema.safeParse(await c.req.json())
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: `Invalid request body: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      })
    }
    body = parsed.data as ChatCompletionRequest
  } catch (err) {
    if (err instanceof HTTPException) throw err
    throw new HTTPException(400, { message: 'Invalid JSON body' })
  }

  // 2. Resolve provider and model
  const { provider: providerName, model: providerModel } = resolveModel(body.model)
  const provider = getProvider(providerName)

  // 3. Safety input check
  const safety = await checkInput(body, { userId, requestLogId: null })
  if (safety.decision !== 'allowed') {
    await logRequest({
      userId,
      proxyKeyId,
      provider: providerName,
      model: body.model,
      requestId,
      statusCode: 400,
      promptHash: hashPrompt(body),
      latencyMs: Date.now() - startedAt,
      safetyDecision: safety.decision,
      safetyCategories: safety.categories,
    })
    throw new HTTPException(400, {
      message: `Request blocked by safety filter (${safety.layer}): ${safety.reason ?? safety.decision}`,
    })
  }

  // 4. Resolve upstream API key
  let apiKey: string
  try {
    apiKey = await resolveUpstreamKey(userId, providerName)
  } catch {
    throw new HTTPException(401, {
      message: `No API key configured for provider "${providerName}"`,
    })
  }

  const env = loadEnv()
  const providerCtx = {
    apiKey,
    model: providerModel,
    requestId,
    timeoutMs: env.NODE_ENV === 'production' ? 300_000 : 120_000,
  }

  // 5. Stream or complete
  if (body.stream) {
    return streamSSE(c, async (stream) => {
      let collected = ''
      try {
        for await (const chunk of provider.stream(body, providerCtx)) {
          collected += chunk.choices[0]?.delta.content ?? ''
          await stream.writeSSE({ data: JSON.stringify(chunk) })
        }
        await stream.writeSSE({ data: '[DONE]' })
      } catch (err) {
        const message = (err as Error).message
        await stream.writeSSE({
          data: JSON.stringify({
            error: { message, type: 'upstream_error', code: 'stream_error' },
          }),
        })
        return
      }

      // Output safety check (fire and forget for latency; still log)
      const outputSafety = await checkOutput(collected, { userId, requestLogId: null })

      await logRequest({
        userId,
        proxyKeyId,
        provider: providerName,
        model: body.model,
        requestId,
        statusCode: 200,
        promptHash: hashPrompt(body),
        latencyMs: Date.now() - startedAt,
        safetyDecision: outputSafety.decision === 'allowed' ? 'allowed' : outputSafety.decision,
        safetyCategories: outputSafety.categories,
      })
    })
  }

  // Non-streaming
  let response: ChatCompletionResponse
  try {
    response = await provider.complete(body, providerCtx)
  } catch (err) {
    await logRequest({
      userId,
      proxyKeyId,
      provider: providerName,
      model: body.model,
      requestId,
      statusCode: 502,
      promptHash: hashPrompt(body),
      latencyMs: Date.now() - startedAt,
      safetyDecision: 'allowed',
    })
    throw err
  }

  // Output safety on full completion
  const outputText = response.choices
    .map((ch) => (typeof ch.message.content === 'string' ? ch.message.content : ''))
    .join('\n')
  const outputSafety = await checkOutput(outputText, { userId, requestLogId: null })

  if (outputSafety.decision !== 'allowed') {
    await logRequest({
      userId,
      proxyKeyId,
      provider: providerName,
      model: body.model,
      requestId,
      statusCode: 400,
      promptHash: hashPrompt(body),
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
      totalTokens: response.usage?.total_tokens,
      latencyMs: Date.now() - startedAt,
      safetyDecision: outputSafety.decision,
      safetyCategories: outputSafety.categories,
    })
    throw new HTTPException(400, {
      message: `Response blocked by output safety filter: ${outputSafety.reason ?? outputSafety.decision}`,
    })
  }

  await logRequest({
    userId,
    proxyKeyId,
    provider: providerName,
    model: body.model,
    requestId,
    statusCode: 200,
    promptHash: hashPrompt(body),
    promptTokens: response.usage?.prompt_tokens,
    completionTokens: response.usage?.completion_tokens,
    totalTokens: response.usage?.total_tokens,
    latencyMs: Date.now() - startedAt,
    safetyDecision: 'allowed',
  })

  return c.json(response)
})

function hashPrompt(req: ChatCompletionRequest): string {
  const material = req.messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
  return crypto.createHash('sha256').update(material).digest('hex')
}
