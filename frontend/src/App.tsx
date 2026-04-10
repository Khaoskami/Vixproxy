import { useEffect, useState } from 'react'

interface Health {
  status: string
  deployment: string
  commit: string
  timestamp: string
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? ''

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const url = `${BACKEND_URL}/health`
    fetch(url)
      .then((r) => r.json())
      .then(setHealth)
      .catch((e: Error) => setError(e.message))
  }, [])

  return (
    <div className="container">
      <h1>Vixproxy</h1>
      <p>
        Multi-provider LLM proxy. Send OpenAI-format requests to{' '}
        <code>/v1/chat/completions</code> and they'll be routed to the right provider.
      </p>

      <div className="card">
        <h2>Backend status</h2>
        {error && (
          <p>
            <span className="status err">error</span> {error}
          </p>
        )}
        {health && (
          <>
            <p>
              <span className="status ok">{health.status}</span>
            </p>
            <ul>
              <li>
                Deployment: <code>{health.deployment}</code>
              </li>
              <li>
                Commit: <code>{health.commit}</code>
              </li>
              <li>
                Checked: <code>{health.timestamp}</code>
              </li>
            </ul>
          </>
        )}
      </div>

      <div className="card">
        <h2>Quick start</h2>
        <p>
          Once you have a proxy API key, point any OpenAI SDK at this backend's{' '}
          <code>/v1</code> endpoint and set the key as your <code>api_key</code>.
        </p>
        <pre>{`curl ${BACKEND_URL || 'https://your-proxy'}/v1/chat/completions \\
  -H "Authorization: Bearer vx_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hi!"}]
  }'`}</pre>
      </div>
    </div>
  )
}
