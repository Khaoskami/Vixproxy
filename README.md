# Vixproxy

Production-grade multi-provider LLM proxy. Send OpenAI-format requests; route to OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Groq, Cohere, or Mistral with provider-aware translation, encrypted-at-rest API keys, multi-layer safety filtering, and audit logging.

## Stack

- **Runtime**: Hono on `@hono/node-server` (Node 20)
- **Hosting**: Railway (Railpack builder, private networking)
- **Database**: Supabase Postgres via Drizzle ORM (postgres-js driver)
- **Auth (end-user)**: Supabase Auth; admin client uses `service_role`
- **Encryption**: AES-256-GCM envelope encryption with versioned keyring
- **Safety**: Keyword blocklist → OpenAI Moderation → LlamaGuard 4 → output filter
- **Frontend**: Vite + React served by Caddy

## Repository layout

```
.
├── backend/                 Hono proxy server
│   ├── src/
│   │   ├── config/          env loader (zod)
│   │   ├── crypto/          AES-256-GCM (+ versioned keyring)
│   │   ├── db/              Drizzle schema + migrator
│   │   ├── middleware/      auth, rate-limit, request-id, error-handler
│   │   ├── providers/       OpenAI-compatible + Anthropic translator
│   │   ├── routes/          health, /v1/chat/completions, /v1/models, /admin
│   │   ├── safety/          keywords, moderation, LlamaGuard, NCMEC pipeline
│   │   ├── services/        provider key resolver, request log
│   │   ├── supabase/        admin client
│   │   └── index.ts         app entry (binds process.env.PORT)
│   ├── Dockerfile
│   └── railway.json
├── frontend/                Vite + React admin UI
│   ├── Caddyfile            serves SPA on $PORT
│   └── Dockerfile
└── .github/workflows/       CI + deploy
```

## Endpoints

| Method | Path                         | Description                                    |
| ------ | ---------------------------- | ---------------------------------------------- |
| GET    | `/health`                    | Liveness / readiness (Railway health check)    |
| POST   | `/v1/chat/completions`       | OpenAI-format chat completions (streaming too) |
| GET    | `/v1/models`                 | List curated model ids                         |
| POST   | `/admin/provider-keys`       | Store an encrypted upstream API key            |
| GET    | `/admin/provider-keys`       | List stored keys (metadata only)               |
| DELETE | `/admin/provider-keys/:id`   | Delete a key                                   |
| POST   | `/admin/proxy-keys`          | Mint a proxy API key (plaintext shown once)    |
| GET    | `/admin/proxy-keys`          | List proxy keys                                |
| POST   | `/admin/proxy-keys/:id/revoke` | Revoke a proxy key                           |

`/v1/*` is authenticated via proxy keys (`Authorization: Bearer vx_live_...` or `x-api-key`). `/admin/*` is authenticated via Supabase Auth JWTs.

## Model routing

Send any of:

```
gpt-4o-mini                       → openai
claude-sonnet-4-5                 → anthropic
gemini-1.5-pro                    → gemini
deepseek-chat                     → deepseek
llama-3.3-70b-versatile           → groq
command-r-plus                    → cohere
mistral-large-latest              → mistral

anthropic/claude-opus-4-6         → anthropic (explicit override)
openrouter/meta-llama/llama-3.3   → openrouter
```

Six of eight providers are OpenAI wire-compatible, so the proxy is a thin pass-through for them. **Anthropic** is fully translated: system prompt extraction, `max_tokens` required, `x-api-key` + `anthropic-version` headers, `content` block → `choices[0].message.content`, SSE event mapping (`message_start`, `content_block_delta`, `message_stop`).

## Encryption at rest

API keys are stored with AES-256-GCM envelope encryption. The storage format is:

```
base64( version(1) || iv(12) || ciphertext || authTag(16) )
```

- **IV is always 12 bytes** (NIST SP 800-38D).
- **Auth tag is 16 bytes** and must be set *before* `decipher.final()`.
- The **version byte** enables key rotation via a keyring; old records remain decryptable while new records use the highest version.
- Rotate keys by adding a new version to `ENCRYPTION_KEY_RING` and running a batch re-encrypt with the exported `rewrap()` helper.

Generate a fresh key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Safety pipeline

Four layers, short-circuiting on the first block:

1. **Keyword / regex** (~µs) — hard CSAM patterns, age+sexual proximity, l33tspeak normalization, bomb-making, self-harm instructions.
2. **OpenAI Moderation API** (`omni-moderation-latest`, ~50–200ms) — 11 categories. The `sexual/minors` threshold is set very low (0.1 default) because the cost of a false negative is catastrophic.
3. **LlamaGuard 4** (~100–500ms, optional) — MLCommons hazard taxonomy; categories S1–S13 including Child Sexual Exploitation. Called via any OpenAI-compatible endpoint.
4. **Output filter** — re-runs keyword + LlamaGuard on the generated response to catch jailbroken outputs.

CSAM-category blocks trigger a `safety_events` row with:

- an **opaque SHA-256 content hash** (never plaintext — storing plaintext could constitute possession under federal law)
- classifier scores, categories, and triggering layer
- a 1-year retention marker (REPORT Act requirement)

An operator-facing NCMEC CyberTipline worker is stubbed in `src/safety/ncmec.ts` and activated by `NCMEC_REPORTING_ENABLED=true`. Actual CyberTipline XML submission requires ESP registration and is intentionally left as a production operator task.

### Legal note — 18 U.S.C. § 2258A

Once your safety filters make you *aware* of apparent CSAM on your systems, reporting to NCMEC "as soon as reasonably possible" is **mandatory** under federal law. The REPORT Act (May 2024) extended CyberTipline data retention to 1 year and raised penalties to $850K per initial violation. Register as an ESP with NCMEC before going live.

## Local development

```bash
# Backend
cd backend
cp .env.example .env.local
# Generate a MASTER_ENCRYPTION_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Paste into .env.local as MASTER_ENCRYPTION_KEY=...
npm install
npm run dev           # http://localhost:3000/health

# Frontend
cd ../frontend
cp .env.example .env.local
npm install
npm run dev           # http://localhost:5173
```

With no `DATABASE_URL` set, the backend runs in dev mode: proxy-key auth passes through (any key works, hashed into a dev user id), and request logs are skipped. Upstream provider keys fall back to the `*_API_KEY` env vars.

## Deploying to Railway

There are two supported setups:

### Option A — single service at repo root (simplest)

Create one Railway service pointed at the repo root (leave Root Directory empty). The root `package.json` + `railway.json` delegate to the backend:

- Root `package.json` has a `build` script (`npm --prefix backend install && npm --prefix backend run build`) that Railpack runs after detecting Node.
- Root `railway.json` sets `startCommand: node backend/dist/index.js` and `healthcheckPath: /health`.
- A root `Dockerfile` is included as a fallback — switch `railway.json` builder to `DOCKERFILE` if you ever need to bypass Railpack.

Set env vars:
- `DATABASE_URL` — Supabase shared pooler, session mode (port 5432)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `MASTER_ENCRYPTION_KEY` — 64 hex chars
- Any provider fallback keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)

The frontend is not deployed in this setup — the backend is standalone.

### Option B — two services (backend + frontend)

Create one Railway project with **two services** pointing at the same repo:

1. **backend** service — set **Root Directory** to `backend` in the service's dashboard settings. Railway will use `backend/railway.json` + `backend/package.json`.
2. **frontend** service — set **Root Directory** to `frontend`. Railway will use `frontend/railway.json` and serve via Caddy.
3. Set backend env vars as in Option A.
4. Set `VITE_BACKEND_URL=https://${{backend.RAILWAY_PUBLIC_DOMAIN}}` on the frontend service (Railway reference variable).
5. Each service's `railway.json` has `watchPatterns` scoped to its directory so cross-service rebuilds are avoided.

Railpack auto-detects Hono/Node for the backend and Vite for the frontend. No extra configuration needed. **The backend binds to `process.env.PORT`** — do not override the start command for the frontend, or SPA auto-detection is disabled.

Health check is `/health`; it returns 200 once the server is listening.

### Troubleshooting

**`Error creating build plan with Railpack`** — Railway is pointing at a directory with no detectable project. Either:
- Option A: ensure the repo root has `package.json` + `railway.json` (both are committed on this repo).
- Option B: set the service's **Root Directory** to `backend` or `frontend` in the Railway dashboard.

### Private networking

If you add additional internal services, reference them via the injected `*.railway.internal` DNS name over plain HTTP (the link is Wireguard-encrypted). Example:

```
WORKER_URL=http://${{safety-worker.RAILWAY_PRIVATE_DOMAIN}}:3000
```

### Custom domain

Add a CNAME pointing to the Railway-issued `*.up.railway.app` host. For apex records, use Cloudflare DNS (CNAME flattening). SSL is auto-provisioned via Let's Encrypt.

## Testing

```bash
cd backend
npm test
```

Unit tests cover the crypto round-trip (including tamper detection, rotation, unicode, empty strings), model routing resolution, keyword safety matches, and LlamaGuard response parsing.

## License

Proprietary — internal to Khaoskami.
