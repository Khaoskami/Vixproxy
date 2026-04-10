/**
 * Minimal Server-Sent Events parser for streaming LLM responses.
 *
 * Handles `data:` and `event:` fields; reassembles multi-line data and yields
 * one event per blank-line-terminated block.
 */
export interface SSEEvent {
  event?: string
  data: string
  id?: string
}

export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncIterable<SSEEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        if (buffer.length > 0) {
          const event = parseBlock(buffer)
          if (event) yield event
        }
        return
      }
      buffer += decoder.decode(value, { stream: true })

      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const event = parseBlock(block)
        if (event) yield event
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* noop */
    }
  }
}

function parseBlock(block: string): SSEEvent | null {
  const lines = block.split('\n')
  let event: string | undefined
  let id: string | undefined
  const dataParts: string[] = []
  for (const raw of lines) {
    if (raw === '' || raw.startsWith(':')) continue
    const colonIdx = raw.indexOf(':')
    if (colonIdx === -1) continue
    const field = raw.slice(0, colonIdx)
    const value = raw[colonIdx + 1] === ' ' ? raw.slice(colonIdx + 2) : raw.slice(colonIdx + 1)
    if (field === 'event') event = value
    else if (field === 'data') dataParts.push(value)
    else if (field === 'id') id = value
  }
  if (dataParts.length === 0 && !event) return null
  return { event, id, data: dataParts.join('\n') }
}
