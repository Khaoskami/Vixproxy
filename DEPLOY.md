# VixProxy — Deploy to Railway

End-to-end walkthrough. Following these steps in order avoids the "Deployment failed during network process → Healthcheck failure" error that happens when env vars or the volume mount aren't ready before the first deploy.

---

## 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/vixproxy.git
git push -u origin main
```

## 2. Generate secrets locally

You need these **before** creating the Railway service so the very first deploy can succeed.

```bash
# SESSION_SECRET — 128-char hex
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# ENCRYPTION_KEY — 64-char hex  ← SAVE THIS IN A PASSWORD MANAGER
# If you lose it, every stored upstream API key becomes unrecoverable.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep both values handy for step 4.

## 3. Create the Railway project

1. [railway.app](https://railway.app) → log in with GitHub.
2. **+ New Project** → **Deploy from GitHub repo** → pick `vixproxy`.
3. **Immediately cancel the first build** (top-right menu on the deployment). It will fail anyway because the volume and env vars aren't set yet — cancelling is just faster.

## 4. Add the Volume (BEFORE redeploying)

The SQLite database and session files live on a persistent volume. **This must be mounted before the first successful deploy**, otherwise the data dir is ephemeral and the healthcheck will sometimes pass and sometimes fail at random.

1. Click the service → **Volumes** tab → **+ New Volume**.
2. **Mount path**: `/app/data`
3. **Size**: `1 GB` (you can grow this later).
4. Save.

> **Why `/app/data`?** That's the directory the Dockerfile pre-creates and `chown`s at startup so the non-root `vixproxy` user can write to it. If you mount the volume anywhere else, set `DB_PATH` to match.

## 5. Set environment variables (BEFORE redeploying)

Service → **Variables** → **Raw editor**, paste this and fill in your values:

```env
NODE_ENV=production
PORT=3000
DB_PATH=/app/data/vixproxy.db
SESSION_SECRET=<paste 128-char hex from step 2>
ENCRYPTION_KEY=<paste 64-char hex from step 2>
BASE_URL=https://placeholder.up.railway.app
```

> `BASE_URL` is a placeholder for now — we'll fix it in step 7 once the public domain exists. The server still boots with the placeholder; it's only used for the CORS allow-list and absolute links.

**Both `SESSION_SECRET` and `ENCRYPTION_KEY` are mandatory.** The server calls `process.exit(1)` on startup if either is missing — that's the most common cause of the "Healthcheck failure" message.

## 6. Trigger a fresh deploy

Service → **Deployments** tab → **⋯** → **Redeploy**.

Watch the logs. You should see:

```
VixProxy running on port 3000 [production]
```

The Network → Healthcheck step should now go green within ~30s.

## 7. Generate a public URL

1. Service → **Settings** → **Networking** → **Generate Domain**.
2. Copy the issued `*.up.railway.app` URL.
3. Go back to **Variables** and update `BASE_URL` to that exact URL (Railway will redeploy automatically).

Verify:

```
GET https://your-app.up.railway.app/api/health
→ 200 {"status":"ok","version":"2.0.0","time":"..."}
```

## 8. Create the superadmin

Service → **⋯** → **Open Shell**:

```bash
npm run seed
```

Enter a username, password, and (optionally) email when prompted. This account has full admin rights.

## 9. Add your first provider key

1. Open `https://your-app.up.railway.app/login` and log in as the superadmin you just created.
2. Go to **Admin Panel** → **Master Keys** → **Add Key**.
3. Paste an OpenAI / Anthropic / Gemini / etc. API key. It is encrypted with AES-256-GCM before being written to SQLite.
4. Users (including yourself) can now create proxy keys (`vix_...`) that are scoped to that master key with per-day request limits.

## 10. Connect a client (SillyTavern / JanitorAI / OpenAI SDK)

Set the API base URL to:

```
https://your-app.up.railway.app/api/v1/chat/completions
```

Use any active proxy key (`vix_...`) as the API key / Bearer token. The proxy is OpenAI wire-compatible — the same key works for Anthropic and Gemini routing because the proxy translates the request format upstream.

---

## Troubleshooting

### "Deployment failed during network process → Healthcheck failure"

This is what the screenshot in the issue shows. In order of likelihood:

1. **Missing env vars.** Double-check that **both** `SESSION_SECRET` **and** `ENCRYPTION_KEY` are set on the service. The server logs `FATAL: Missing environment variable: <name>` and exits with code 1 — open the **Build/Deploy logs** to confirm.
2. **Volume not mounted, or mounted at the wrong path.** `DB_PATH` must point inside the mounted volume. The default `/app/data/vixproxy.db` requires a volume mounted at `/app/data`.
3. **Volume permissions.** The Dockerfile runs as the non-root `vixproxy` user. The bundled entrypoint `chown`s the mount on every startup so this Just Works — if you've forked and modified the Dockerfile, make sure that step is still there.
4. **Healthcheck timeout too short.** `railway.toml` ships with `healthcheckTimeout = 300`. Don't lower it below ~60s; cold-starting `better-sqlite3` and creating the schema can take 10–20s on a fresh volume.
5. **Wrong port.** The server reads `process.env.PORT` and binds `0.0.0.0`. Don't override the start command, and leave `PORT=3000` matching `railway.toml`'s `internalPort`.

### Server boots but `/api/health` returns 502 from Railway's edge

The internal port in `railway.toml` (`3000`) must match what the server binds. If you've set `PORT` to anything other than `3000`, also update `[service].internalPort` in `railway.toml`.

### `EACCES: permission denied, open '/app/data/vixproxy.db'`

The volume is owned by root and the entrypoint chown didn't run. Either:

- Redeploy after pulling the latest Dockerfile (which adds the entrypoint chown), **or**
- One-off fix from the Railway shell: `sudo chown -R vixproxy:vixproxy /app/data` and restart.

### Lost `ENCRYPTION_KEY`

There is no recovery. Every encrypted upstream API key in `master_keys` is permanently unreadable. Rotate every upstream key with the provider, generate a new `ENCRYPTION_KEY`, and re-add the master keys via the admin UI.
