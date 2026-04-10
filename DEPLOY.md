# VixProxy — Deploy in 10 Minutes

## 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/vixproxy.git
git push -u origin main
```

## 2. Railway Setup

1. Go to [railway.app](https://railway.app) → Login with GitHub
2. **+ New Project** → Deploy from GitHub repo → select `vixproxy`
3. Let the first build fail (no env vars yet)

## 3. Add a Volume

1. Click the service → **Volumes** tab → **+ Add Volume**
2. Mount Path: `/app/data`  |  Size: `1 GB`
3. Save

## 4. Generate Secrets (run locally)

```bash
# SESSION_SECRET (copy output)
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# ENCRYPTION_KEY (copy output) — SAVE THIS IN A PASSWORD MANAGER
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 5. Set Environment Variables

In Railway → service → **Variables**:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `DB_PATH` | `/app/data/vixproxy.db` |
| `SESSION_SECRET` | *(128-char hex from step 4)* |
| `ENCRYPTION_KEY` | *(64-char hex from step 4)* |
| `BASE_URL` | `https://your-app.up.railway.app` *(update after step 6)* |

Click **Deploy**.

## 6. Get Your Public URL

Service → **Settings** → **Networking** → **Generate Domain**

Update `BASE_URL` in Variables to match (triggers redeploy).

## 7. Create Superadmin

Railway service → **⋯** → **Open Shell**:

```bash
npm run seed
```

Enter username + password when prompted.

## 8. Go Live

1. Open your Railway URL
2. Login as superadmin
3. Go to **Admin Panel** → **Master Keys** → add your first provider API key
4. Users can now register and create proxy keys that point to it

## Client Setup (SillyTavern / JanitorAI)

Set API base URL to:
```
https://your-app.up.railway.app/api/v1/chat/completions
```
Use any active proxy key (`vix_...`) as the API Key / Bearer token.

## Health Check

```
GET https://your-app.up.railway.app/api/health
→ {"status":"ok","version":"2.0.0"}
```
