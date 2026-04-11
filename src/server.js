import 'dotenv/config';

// ─── Validate required env vars BEFORE importing anything that reads them ──
// database.js opens the SQLite file on import and utils/crypto.js throws
// when ENCRYPTION_KEY is missing or malformed. Validating after those imports
// would bury the clear "FATAL: Missing X" message under a cryptic stack trace.
const REQUIRED = ['SESSION_SECRET', 'ENCRYPTION_KEY'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing environment variable: ${key}`);
    process.exit(1);
  }
}
if (process.env.ENCRYPTION_KEY.length !== 64) {
  console.error(
    `FATAL: ENCRYPTION_KEY must be 64 hex chars (32 bytes), got ${process.env.ENCRYPTION_KEY.length}`
  );
  process.exit(1);
}

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import FileStore from 'session-file-store';
import hpp from 'hpp';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import logger from './utils/logger.js';
import db from './models/database.js';

import authRoutes from './routes/auth.js';
import proxyRoutes from './routes/proxy.js';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3000');
const IS_PROD = process.env.NODE_ENV === 'production';

// ─── Session store ───────────────────────────────────────────────────────────
const SessionFileStore = FileStore(session);
const sessionDir = path.join(path.dirname(process.env.DB_PATH || './data/vixproxy.db'), 'sessions');
if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

// ─── Security middleware ─────────────────────────────────────────────────────
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

app.use(cors({
  origin: process.env.BASE_URL || false,
  credentials: true,
}));

app.use(hpp());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Global rate limit
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.GLOBAL_RATE_LIMIT_MAX || '200'),
  standardHeaders: true,
  legacyHeaders: false,
}));

// ─── Sessions ────────────────────────────────────────────────────────────────
app.use(session({
  store: new SessionFileStore({ path: sessionDir, ttl: 7 * 24 * 3600, reapInterval: 3600 }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'vix.sid',
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// ─── Request logging ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// ─── Static files ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/', authRoutes);
app.use('/api/proxy', proxyRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);

// OpenAI-compatible endpoint (top-level for easy client config)
app.use('/api', proxyRoutes);

// ─── Health check ─────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', time: new Date().toISOString() });
});

// ─── SPA-style page routes ───────────────────────────────────────────────
const pages = ['dashboard', 'admin', 'login', 'register'];
for (const page of pages) {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(`${page}.html`, { root: path.join(__dirname, '../public') });
  });
}

app.get('/', (req, res) => {
  if (req.session?.userId) return res.redirect('/dashboard');
  res.redirect('/login');
});

// ─── 404 / Error handlers ────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile('404.html', { root: path.join(__dirname, '../public') }, () => {
    res.status(404).send('Not found');
  });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error', err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Internal server error' });
  res.status(500).send('Internal server error');
});

// ─── Daily reset cron (lightweight, no external deps) ───────────────────
function runDailyReset() {
  try {
    db.prepare(`
      UPDATE users SET requests_used_today = 0, last_reset_at = unixepoch()
      WHERE last_reset_at < unixepoch() - 86400
    `).run();
    db.prepare(`
      UPDATE proxy_keys SET daily_used = 0, last_reset_at = unixepoch()
      WHERE last_reset_at < unixepoch() - 86400
    `).run();
    db.prepare(`
      UPDATE master_keys SET daily_used = 0, last_reset_at = unixepoch()
      WHERE last_reset_at < unixepoch() - 86400
    `).run();
  } catch (err) {
    logger.error('Daily reset failed', err);
  }
}

// Run reset every hour (covers timezone edge cases)
setInterval(runDailyReset, 60 * 60 * 1000);
runDailyReset(); // Run on startup too

// ─── Start ────────────────────────────────────────────────────────────────
// Log before listen() so we can see the bound port even if something crashes
// during the listen callback. process.env.PORT comes from Railway's runtime
// injection; hardcoding internalPort in railway.toml caused a mismatch when
// Railway routed to 3000 while the app bound to a different injected value.
console.log(`[startup] binding 0.0.0.0:${PORT} (process.env.PORT=${process.env.PORT ?? 'unset'})`);
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`VixProxy running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});
server.on('error', (err) => {
  console.error(`[startup] listen failed on port ${PORT}:`, err);
  process.exit(1);
});

export default app;
