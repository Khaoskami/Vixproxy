import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import qrcode from 'qrcode';
import db from '../models/database.js';
import { generateId } from '../utils/crypto.js';
import { audit } from '../utils/audit.js';
import logger from '../utils/logger.js';
import rateLimit from 'express-rate-limit';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '5'),
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /login
router.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/dashboard');
  res.sendFile('login.html', { root: 'public' });
});

// GET /register
router.get('/register', (req, res) => {
  if (req.session?.userId) return res.redirect('/dashboard');
  res.sendFile('register.html', { root: 'public' });
});

// POST /api/auth/register
router.post('/api/auth/register', loginLimiter, async (req, res) => {
  try {
    const { username, password, invite_code } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    if (username.length < 3 || username.length > 32) {
      return res.status(400).json({ error: 'Username must be 3-32 characters' });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, _ and -' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    let role = 'user';

    // Check invite code for admin promotion
    if (invite_code) {
      const code = db.prepare(
        "SELECT * FROM invite_codes WHERE code = ? AND status = 'pending'"
      ).get(invite_code);

      if (!code) {
        return res.status(400).json({ error: 'Invalid or expired invite code' });
      }

      if (code.expires_at && code.expires_at < Math.floor(Date.now() / 1000)) {
        db.prepare("UPDATE invite_codes SET status = 'expired' WHERE id = ?").run(code.id);
        return res.status(400).json({ error: 'Invite code expired' });
      }

      role = code.type; // 'admin' or 'superadmin'

      // Mark code as used
      db.prepare(
        "UPDATE invite_codes SET status = 'used', used_at = unixepoch() WHERE id = ?"
      ).run(code.id);
    }

    const hash = await bcrypt.hash(password, 12);
    const id = generateId();

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
    `).run(id, username, hash, role);

    if (invite_code) {
      db.prepare("UPDATE invite_codes SET used_by = ? WHERE code = ?").run(id, invite_code);
    }

    audit(id, username, 'register', 'user', id, { role }, req.ip);
    logger.info('User registered', { username, role });

    req.session.userId = id;
    req.session.username = username;

    res.json({ success: true, role });
  } catch (err) {
    logger.error('Register error', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password, totp } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check account lock
    if (user.locked_until && user.locked_until > Math.floor(Date.now() / 1000)) {
      const waitMin = Math.ceil((user.locked_until - Math.floor(Date.now() / 1000)) / 60);
      return res.status(423).json({ error: `Account locked. Try again in ${waitMin} minutes.` });
    }

    if (user.is_banned) {
      return res.status(403).json({ error: `Account banned: ${user.ban_reason || 'policy violation'}` });
    }

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      const fails = user.failed_logins + 1;
      const lockUntil = fails >= 5 ? Math.floor(Date.now() / 1000) + 15 * 60 : null;
      db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
        .run(fails, lockUntil, user.id);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check 2FA
    if (user.totp_enabled && user.totp_secret) {
      if (!totp) {
        return res.status(200).json({ requires2fa: true });
      }
      const valid2fa = authenticator.check(totp, user.totp_secret);
      if (!valid2fa) {
        return res.status(401).json({ error: 'Invalid 2FA code' });
      }
    }

    // Reset failed logins
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;

    audit(user.id, user.username, 'login', 'user', user.id, {}, req.ip);

    res.json({ success: true, role: user.role });
  } catch (err) {
    logger.error('Login error', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
router.post('/api/auth/logout', (req, res) => {
  if (req.session?.userId) {
    audit(req.session.userId, req.session.username, 'logout', 'user', req.session.userId, {}, req.ip);
  }
  req.session.destroy(() => res.json({ success: true }));
});

// GET /api/auth/me
router.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare(
    'SELECT id, username, role, totp_enabled, daily_request_limit, requests_used_today, created_at FROM users WHERE id = ?'
  ).get(req.session.userId);
  res.json(user);
});

// POST /api/auth/2fa/setup
router.post('/api/auth/2fa/setup', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const secret = authenticator.generateSecret();
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.userId);
  const otpauth = authenticator.keyuri(user.username, 'VixProxy', secret);
  const qr = await qrcode.toDataURL(otpauth);

  // Store secret temporarily in session until verified
  req.session.pending2faSecret = secret;

  res.json({ secret, qr });
});

// POST /api/auth/2fa/verify
router.post('/api/auth/2fa/verify', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { totp } = req.body;
  const secret = req.session.pending2faSecret;

  if (!secret) return res.status(400).json({ error: 'No pending 2FA setup' });

  const valid = authenticator.check(totp, secret);
  if (!valid) return res.status(400).json({ error: 'Invalid code' });

  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?')
    .run(secret, req.session.userId);
  delete req.session.pending2faSecret;

  res.json({ success: true });
});

// POST /api/auth/2fa/disable
router.post('/api/auth/2fa/disable', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid password' });

  db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?')
    .run(req.session.userId);
  res.json({ success: true });
});

export default router;
