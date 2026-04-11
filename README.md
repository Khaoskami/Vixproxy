# VixProxy

Hardened, multi-user LLM key proxy. Users hold short-lived `vix_...` proxy keys; the server holds the real provider API keys (encrypted at rest with AES-256-GCM) and forwards OpenAI-format requests to OpenAI, Anthropic, Google, OpenRouter, DeepSeek, Groq, Cohere, or Mistral.

Designed to drop into Railway with a SQLite volume — no external database required.

## Stack

- **Runtime**: Node 20 + Express 4
- **Database**: `better-sqlite3` (single file on a Railway Volume)
- **Auth**: `express-session` + bcrypt + optional TOTP (`otplib`)
- **Encryption**: AES-256-GCM for upstream provider keys at rest
- **Hardening**: `helmet`, `hpp`, `cors`, `express-rate-limit`, file-backed sessions
- **Frontend**: static HTML in `public/` (login, register, dashboard, admin)

## Repository layout

```
.
├── src/
│   ├── server.js              Express app entry, binds 0.0.0.0:$PORT
│   ├── models/database.js     better-sqlite3 schema + migrations
│   ├── middleware/auth.js     Session + role checks
│   ├── routes/
│   │   ├── auth.js            login, register, logout, TOTP
│   │   ├── user.js            profile, proxy-key CRUD
│   │   ├── admin.js           users, master keys, audit log
│   │   └── proxy.js           /api/v1/chat/completions (OpenAI-compatible)
│   ├── services/
│   │   ├── proxy.js           Provider routing + request forwarding
│   │   └── csam.js            Safety / content filtering
│   └── utils/
│       ├── crypto.js          AES-256-GCM helpers
│       ├── audit.js           Audit log writer
│       ├── logger.js          winston logger
│       └── seed-admin.js      `npm run seed` — create the first superadmin
├── public/                    Static HTML pages served by Express
├── Dockerfile                 Production image (Node 20 alpine + tini)
├── railway.toml               Railway deploy config (healthcheck, port)
├── nixpacks.toml              Nixpacks fallback build
├── DEPLOY.md                  Step-by-step Railway deploy guide
└── .env.example               Required environment variables
```

## Endpoints

| Method | Path                          | Auth        | Description                                |
| ------ | ----------------------------- | ----------- | ------------------------------------------ |
| GET    | `/api/health`                 | public      | Liveness probe (Railway healthcheck path)  |
| POST   | `/login`, `/register`         | public      | Session login / signup                     |
| POST   | `/api/v1/chat/completions`    | proxy key   | OpenAI-compatible chat completions         |
| GET    | `/api/v1/models`              | proxy key   | List available models                      |
| GET    | `/api/user/*`                 | session     | Profile + own proxy keys                   |
| GET    | `/api/admin/*`                | admin role  | Users, master keys, audit log              |

`/api/v1/*` accepts a proxy key as `Authorization: Bearer vix_...`.

## Required environment variables

| Variable          | Required | Notes                                                                 |
| ----------------- | :------: | --------------------------------------------------------------------- |
| `SESSION_SECRET`  |    ✓     | 64-byte hex. Server **exits on startup** if missing.                  |
| `ENCRYPTION_KEY`  |    ✓     | 32-byte hex (64 hex chars). **Losing this = all stored keys lost.**   |
| `DB_PATH`         |          | Defaults to `./data/vixproxy.db`. On Railway use `/app/data/vixproxy.db`. |
| `PORT`            |          | Defaults to `3000`. Railway injects this automatically.               |
| `NODE_ENV`        |          | Set to `production` on Railway.                                       |
| `BASE_URL`        |          | Public URL — used for the CORS allow-list and absolute links.         |
| `GLOBAL_RATE_LIMIT_MAX` |    | Per-IP requests/min, default 200.                                     |

Generate the secrets:

```bash
# SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Local development

```bash
git clone https://github.com/khaoskami/vixproxy.git
cd vixproxy
cp .env.example .env
# Fill in SESSION_SECRET and ENCRYPTION_KEY in .env
npm install
node src/server.js
# → http://localhost:3000/api/health
```

Create the first superadmin (interactive):

```bash
npm run seed
```

## Deployment

The full Railway walkthrough lives in [`DEPLOY.md`](./DEPLOY.md). The short version:

1. Push this repo to GitHub.
2. New Railway project → Deploy from GitHub repo.
3. Add a **Volume** mounted at `/app/data` (matches the `DB_PATH` env var).
4. Set `SESSION_SECRET`, `ENCRYPTION_KEY`, `NODE_ENV=production`, `DB_PATH=/app/data/vixproxy.db`.
5. Generate a public domain → set `BASE_URL` to the issued URL.
6. Open a shell on the service and run `npm run seed` to create the superadmin.

Railway healthchecks `/api/health` on the internal port `3000`. The server binds `0.0.0.0:$PORT` so this works without extra config.

### Healthcheck

```
GET /api/health
→ 200 {"status":"ok","version":"2.0.0","time":"..."}
```

If Railway reports **"Deployment failed during network process → Healthcheck failure"**, see the troubleshooting section in [`DEPLOY.md`](./DEPLOY.md#troubleshooting). The two most common causes are: (a) `SESSION_SECRET` or `ENCRYPTION_KEY` missing — the server `process.exit(1)`s on boot — and (b) the volume at `/app/data` is owned by root, so the non-root `vixproxy` user can't write the SQLite file. The Dockerfile entrypoint now `chown`s the mount on start to fix this automatically.

## Security notes

- API keys are encrypted at rest with AES-256-GCM. The `ENCRYPTION_KEY` is the **only** thing that can decrypt them — keep a copy in a password manager.
- Sessions are file-backed under the same volume as the SQLite DB; cookies are `httpOnly`, `sameSite=strict`, and `secure` in production.
- `helmet` sets a strict CSP, HSTS (in production), and the usual hardening headers.
- Login + global rate limits are enforced via `express-rate-limit`. Brute-force attempts lock the account after repeated failures.
- `trust proxy` is set to `1` so Railway's edge proxy IPs are honored for rate limiting and audit logs.

## License

Proprietary — internal to Khaoskami.
