import { Router } from 'express';
import { requireAdmin, requireSuperadmin } from '../middleware/auth.js';
import db from '../models/database.js';
import { encrypt, generateId, generateInviteCode } from '../utils/crypto.js';
import { audit } from '../utils/audit.js';
import bcrypt from 'bcryptjs';

const router = Router();

// ─── MASTER KEYS (superadmin only) ─────────────────────────────────────────

router.get('/master-keys', requireAdmin, (req, res) => {
  const keys = db.prepare(`
    SELECT id, name, provider, models, base_url, is_active,
           daily_quota, daily_used, last_reset_at, created_by, created_at
    FROM master_keys ORDER BY created_at DESC
  `).all();
  res.json(keys.map(k => ({ ...k, models: JSON.parse(k.models || '[]') })));
});

router.post('/master-keys', requireSuperadmin, (req, res) => {
  const { name, provider, api_key, models, base_url, daily_quota } = req.body;

  if (!name || !provider || !api_key) {
    return res.status(400).json({ error: 'name, provider, and api_key required' });
  }

  const validProviders = ['openai', 'anthropic', 'openrouter', 'groq', 'google', 'mistral', 'deepseek', 'custom'];
  if (!validProviders.includes(provider)) {
    return res.status(400).json({ error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
  }

  const { iv, data, tag } = encrypt(api_key);
  const id = generateId();

  db.prepare(`
    INSERT INTO master_keys (id, name, provider, encrypted_key, key_iv, key_tag, models, base_url,
      daily_quota, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
  `).run(id, name, provider, data, iv, tag, JSON.stringify(models || []), base_url || null,
    daily_quota || 50000, req.user.id);

  audit(req.user.id, req.user.username, 'create_master_key', 'master_key', id, { name, provider }, req.ip);
  res.json({ id, name, provider });
});

router.patch('/master-keys/:id', requireSuperadmin, (req, res) => {
  const { is_active, daily_quota, models, name } = req.body;
  const mk = db.prepare('SELECT id FROM master_keys WHERE id = ?').get(req.params.id);
  if (!mk) return res.status(404).json({ error: 'Not found' });

  if (is_active !== undefined) {
    db.prepare('UPDATE master_keys SET is_active = ?, updated_at = unixepoch() WHERE id = ?')
      .run(is_active ? 1 : 0, req.params.id);
  }
  if (daily_quota !== undefined) {
    db.prepare('UPDATE master_keys SET daily_quota = ?, updated_at = unixepoch() WHERE id = ?')
      .run(daily_quota, req.params.id);
  }
  if (models !== undefined) {
    db.prepare('UPDATE master_keys SET models = ?, updated_at = unixepoch() WHERE id = ?')
      .run(JSON.stringify(models), req.params.id);
  }
  if (name !== undefined) {
    db.prepare('UPDATE master_keys SET name = ?, updated_at = unixepoch() WHERE id = ?')
      .run(name, req.params.id);
  }

  audit(req.user.id, req.user.username, 'update_master_key', 'master_key', req.params.id, req.body, req.ip);
  res.json({ success: true });
});

router.delete('/master-keys/:id', requireSuperadmin, (req, res) => {
  db.prepare('UPDATE master_keys SET is_active = 0 WHERE id = ?').run(req.params.id);
  audit(req.user.id, req.user.username, 'delete_master_key', 'master_key', req.params.id, {}, req.ip);
  res.json({ success: true });
});

// ─── USERS ────────────────────────────────────────────────────────────────

router.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, username, role, email, is_banned, ban_reason, daily_request_limit,
           requests_used_today, created_at,
           (SELECT COUNT(*) FROM proxy_keys WHERE user_id = users.id AND status = 'active') as active_keys,
           (SELECT COUNT(*) FROM request_logs WHERE user_id = users.id) as total_requests
    FROM users ORDER BY created_at DESC
  `).all();
  res.json(users);
});

router.patch('/users/:id', requireAdmin, (req, res) => {
  const { is_banned, ban_reason, daily_request_limit, role } = req.body;
  const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Only superadmin can change roles
  if (role !== undefined && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Only superadmin can change roles' });
  }

  if (is_banned !== undefined) {
    db.prepare('UPDATE users SET is_banned = ?, ban_reason = ?, updated_at = unixepoch() WHERE id = ?')
      .run(is_banned ? 1 : 0, ban_reason || null, req.params.id);
  }
  if (daily_request_limit !== undefined) {
    db.prepare('UPDATE users SET daily_request_limit = ?, updated_at = unixepoch() WHERE id = ?')
      .run(daily_request_limit, req.params.id);
  }
  if (role !== undefined) {
    const validRoles = ['user', 'admin', 'superadmin'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    db.prepare('UPDATE users SET role = ?, updated_at = unixepoch() WHERE id = ?').run(role, req.params.id);
  }

  audit(req.user.id, req.user.username, 'update_user', 'user', req.params.id, req.body, req.ip);
  res.json({ success: true });
});

// ─── INVITE CODES ─────────────────────────────────────────────────────────

router.get('/invite-codes', requireAdmin, (req, res) => {
  const codes = db.prepare(`
    SELECT ic.*, u.username as created_by_username, u2.username as used_by_username
    FROM invite_codes ic
    LEFT JOIN users u ON ic.created_by = u.id
    LEFT JOIN users u2 ON ic.used_by = u2.id
    ORDER BY ic.created_at DESC
  `).all();
  res.json(codes);
});

router.post('/invite-codes', requireAdmin, (req, res) => {
  const { type, expires_hours } = req.body;
  const validTypes = ['admin', 'superadmin'];

  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'type must be admin or superadmin' });
  }

  // Only superadmin can create superadmin invite codes
  if (type === 'superadmin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Only superadmin can create superadmin invite codes' });
  }

  const code = generateInviteCode();
  const id = generateId();
  const expiresAt = expires_hours
    ? Math.floor(Date.now() / 1000) + expires_hours * 3600
    : null;

  db.prepare(`
    INSERT INTO invite_codes (id, code, type, created_by, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
  `).run(id, code, type, req.user.id, expiresAt);

  audit(req.user.id, req.user.username, 'create_invite_code', 'invite_code', id, { type }, req.ip);
  res.json({ id, code, type, expires_at: expiresAt });
});

router.delete('/invite-codes/:id', requireAdmin, (req, res) => {
  db.prepare("UPDATE invite_codes SET status = 'expired' WHERE id = ?").run(req.params.id);
  audit(req.user.id, req.user.username, 'expire_invite_code', 'invite_code', req.params.id, {}, req.ip);
  res.json({ success: true });
});

// ─── AUDIT LOGS ───────────────────────────────────────────────────────────

router.get('/audit-logs', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  const offset = parseInt(req.query.offset || '0');

  const logs = db.prepare(`
    SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  res.json(logs);
});

// ─── REQUEST LOGS ─────────────────────────────────────────────────────────

router.get('/request-logs', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  const offset = parseInt(req.query.offset || '0');
  const csamOnly = req.query.csam === '1';

  let query = `
    SELECT rl.*, u.username
    FROM request_logs rl
    LEFT JOIN users u ON rl.user_id = u.id
    ${csamOnly ? 'WHERE rl.csam_flagged = 1' : ''}
    ORDER BY rl.created_at DESC LIMIT ? OFFSET ?
  `;

  const logs = db.prepare(query).all(limit, offset);
  res.json(logs);
});

// ─── DASHBOARD STATS ──────────────────────────────────────────────────────

router.get('/stats', requireAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get();
  const activeUsers = db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM request_logs WHERE created_at > unixepoch() - 86400").get();
  const requestsToday = db.prepare("SELECT COUNT(*) as c FROM request_logs WHERE created_at > unixepoch() - 86400").get();
  const tokensToday = db.prepare("SELECT COALESCE(SUM(total_tokens), 0) as t FROM request_logs WHERE created_at > unixepoch() - 86400").get();
  const csamToday = db.prepare("SELECT COUNT(*) as c FROM request_logs WHERE csam_flagged = 1 AND created_at > unixepoch() - 86400").get();
  const activeProxyKeys = db.prepare("SELECT COUNT(*) as c FROM proxy_keys WHERE status = 'active'").get();
  const activeMasterKeys = db.prepare("SELECT COUNT(*) as c FROM master_keys WHERE is_active = 1").get();

  // Daily trend last 7 days
  const dailyTrend = db.prepare(`
    SELECT date(created_at, 'unixepoch') as day, COUNT(*) as requests, SUM(total_tokens) as tokens
    FROM request_logs
    WHERE created_at > unixepoch() - 7*86400
    GROUP BY day ORDER BY day ASC
  `).all();

  res.json({
    totalUsers: totalUsers.c,
    activeUsersToday: activeUsers.c,
    requestsToday: requestsToday.c,
    tokensToday: tokensToday.t,
    csamFlagsToday: csamToday.c,
    activeProxyKeys: activeProxyKeys.c,
    activeMasterKeys: activeMasterKeys.c,
    dailyTrend,
  });
});

export default router;
