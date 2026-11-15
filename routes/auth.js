import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import db from '../db.js';
import { sha256, publicUser, usernameSchema } from '../lib.js';
import { auth, body, COOKIE, cookieOpts } from '../middleware.js';
import { botLink } from '../telegram.js';

const r = Router();
const prod = process.env.NODE_ENV === 'production';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const DAY = 864e5;
const LOGIN_TTL = 5 * 60e3;
const pollOpts = { httpOnly: true, secure: prod, sameSite: 'lax', path: '/api/auth' };
const limit = (n, windowMs) => rateLimit({ windowMs, limit: n, standardHeaders: 'draft-7', legacyHeaders: false });
const hex = (n) => crypto.randomBytes(n).toString('hex');

// Выдаёт сессию: случайный токен в httpOnly-куке, в БД только его хэш.
function issueSession(res, userId) {
  const token = hex(32);
  db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)').run(
    sha256(token), userId, Date.now() + SESSION_MS, Date.now()
  );
  res.cookie(COOKIE, token, { ...cookieOpts, maxAge: SESSION_MS });
}
const pollHash = (req, name) => {
  const t = req.cookies?.[name];
  return typeof t === 'string' && t.length === 64 ? sha256(t) : null;
};

// ---------- Регистрация: юзернейм -> заявка в Telegram-боте -> одобрение админом ----------
const regSchema = z.object({ username: usernameSchema, displayName: z.string().trim().max(40).optional() }).strict();

r.post('/register', limit(10, 3600_000), body(regSchema), (req, res) => {
  const { username, displayName } = req.data;
  const now = Date.now();
  if (!botLink('x')) return res.status(503).json({ error: 'bot_unavailable' });

  // повторное нажатие в том же браузере: отдаём ту же ссылку
  const mine = pollHash(req, 'reg_poll');
  const same = mine && db.prepare("SELECT code FROM registrations WHERE poll_hash = ? AND username = ? AND status = 'new' AND created_at > ?").get(mine, username, now - DAY);
  if (same) return res.json({ botLink: botLink('reg_' + same.code) });

  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'username_taken' });
  if (db.prepare("SELECT 1 FROM registrations WHERE username = ? AND status IN ('new','sent') AND created_at > ?").get(username, now - DAY)) {
    return res.status(409).json({ error: 'username_taken' });
  }
  const code = hex(16);
  const poll = hex(32);
  db.prepare('INSERT INTO registrations(username, display_name, code, poll_hash, created_at) VALUES (?,?,?,?,?)').run(
    username, displayName || null, code, sha256(poll), now
  );
  res.cookie('reg_poll', poll, { ...pollOpts, maxAge: DAY });
  res.status(201).json({ botLink: botLink('reg_' + code) });
});

// Сайт спрашивает статус заявки. Когда админ одобрил, этот же браузер получает сессию.
r.post('/register/status', (req, res) => {
  const h = pollHash(req, 'reg_poll');
  const reg = h && db.prepare('SELECT * FROM registrations WHERE poll_hash = ? AND created_at > ?').get(h, Date.now() - DAY);
  if (!reg) return res.json({ status: 'none' });
  if (reg.status !== 'approved') return res.json({ status: reg.status }); // new | sent | rejected
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND telegram_id = ?').get(reg.username, reg.telegram_id);
  if (!user) return res.json({ status: 'none' });
  issueSession(res, user.id);
  res.clearCookie('reg_poll', pollOpts);
  db.prepare('DELETE FROM registrations WHERE id = ?').run(reg.id);
  res.json({ status: 'approved', user: publicUser(user) });
});

// ---------- Вход: юзернейм -> подтверждение кнопкой в Telegram-боте ----------
r.post('/login/start', limit(20, 15 * 60_000), body(z.object({ username: usernameSchema }).strict()), (req, res) => {
  if (!botLink('x')) return res.status(503).json({ error: 'bot_unavailable' });
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(req.data.username);
  if (!u) return res.status(404).json({ error: 'user_not_found' });
  const code = hex(16);
  const poll = hex(32);
  db.prepare('INSERT INTO login_requests(user_id, code, poll_hash, created_at) VALUES (?,?,?,?)').run(u.id, code, sha256(poll), Date.now());
  res.cookie('login_poll', poll, { ...pollOpts, maxAge: LOGIN_TTL });
  res.json({ botLink: botLink('login_' + code) });
});

r.post('/login/status', (req, res) => {
  const h = pollHash(req, 'login_poll');
  const lr = h && db.prepare('SELECT * FROM login_requests WHERE poll_hash = ? AND created_at > ?').get(h, Date.now() - LOGIN_TTL);
  if (!lr) return res.json({ status: 'expired' });
  if (lr.status !== 'confirmed') return res.json({ status: lr.status }); // pending | denied
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lr.user_id);
  issueSession(res, user.id);
  res.clearCookie('login_poll', pollOpts);
  db.prepare('DELETE FROM login_requests WHERE id = ?').run(lr.id);
  res.json({ status: 'confirmed', user: publicUser(user) });
});

r.post('/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
  res.clearCookie(COOKIE, cookieOpts);
  res.json({ ok: true });
});

r.post('/logout-all', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
  res.clearCookie(COOKIE, cookieOpts);
  res.json({ ok: true });
});

export default r;
