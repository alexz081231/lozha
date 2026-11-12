// Пароли (scrypt), сессии в httpOnly-cookie, защита от перебора, проверка Origin.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from './db.js';
import { SESSION_TTL, OWNER_LOGIN, OWNER_PASSWORD, TRUST_PROXY } from './config.js';
import { setSetting } from './db.js';
import { log } from './util.js';

const scrypt = promisify(crypto.scrypt);
const N = 32768, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pw).normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: 256 * N * R });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  try {
    const [alg, n, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = await scrypt(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64'), want.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * Number(n) * Number(r),
    });
    return crypto.timingSafeEqual(want, got);
  } catch { return false; }
}

export const loginKey = (s) => String(s || '').normalize('NFKC').trim().toLowerCase();
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function publicUser(u) {
  return u && { id: u.id, login: u.login, name: u.name, role: u.role, avatar: u.avatar ? `/avatars/${u.avatar}` : '' };
}

export function createSession(userId, ua) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sql('INSERT INTO sessions (id, user_id, created_at, last_seen, ua) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(token), userId, now, now, String(ua || '').slice(0, 200));
  return token;
}

export function userByToken(token) {
  if (!token) return null;
  const sid = hashToken(token);
  const row = sql(`SELECT s.last_seen AS seen, u.id, u.login, u.name, u.role, u.avatar, u.pass
                   FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(sid);
  if (!row) return null;
  const now = Date.now();
  if (now - row.seen > SESSION_TTL) {
    sql('DELETE FROM sessions WHERE id = ?').run(sid);
    return null;
  }
  if (now - row.seen > 600e3) sql('UPDATE sessions SET last_seen = ? WHERE id = ?').run(now, sid);
  return { id: row.id, login: row.login, name: row.name, role: row.role, avatar: row.avatar, pass: row.pass, sid };
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const isSecure = (req) => !!req.socket.encrypted
  || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

// У http и https разные имена, чтобы вкладки на двух портах не мешали друг другу.
export const cookieName = (req) => (isSecure(req) ? 'lozha_s' : 'lozha');

export function currentUser(req) {
  if (req._user !== undefined) return req._user;
  let token = null;
  try { token = parseCookies(req)[cookieName(req)]; } catch {}
  req._user = userByToken(token);
  return req._user;
}

export function sessionCookie(req, token) {
  const secure = isSecure(req) ? '; Secure' : '';
  if (!token) return `${cookieName(req)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  return `${cookieName(req)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}${secure}`;
}

export function destroySession(sid) {
  sql('DELETE FROM sessions WHERE id = ?').run(sid);
}
export function destroyUserSessions(userId, exceptSid = null) {
  if (exceptSid) sql('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, exceptSid);
  else sql('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Запросы, меняющие состояние, принимаем только со своего сайта.
export function originOk(req) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (origin) {
    try { return new URL(origin).host === host; } catch { return false; }
  }
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  return true; // не браузер: CSRF тут невозможен
}
export function wsOriginOk(req) {
  try { return !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}

// ── Защита от перебора ────────────────────────────────────────────────────
const fails = new Map(); // ключ → { count, first, until, level }

export function guardWait(keys) {
  const now = Date.now();
  let wait = 0;
  for (const k of keys) {
    const f = fails.get(k);
    if (f && f.until > now) wait = Math.max(wait, Math.ceil((f.until - now) / 1000));
  }
  return wait;
}
export function guardFail(keys, limits = {}) {
  const now = Date.now();
  for (const k of keys) {
    const limit = limits[k] || 5;
    let f = fails.get(k);
    if (!f || now - f.first > 15 * 60e3) f = { count: 0, first: now, until: 0, level: f && now - f.first < 3600e3 ? f.level : 0 };
    f.count++;
    if (f.count >= limit) {
      f.level = Math.min(f.level + 1, 7);
      f.until = now + 30e3 * 2 ** (f.level - 1); // 30 с, 1 мин, 2 мин … до 32 мин
      f.count = 0;
      f.first = now;
    }
    fails.set(k, f);
  }
}
export function guardOk(keys) {
  for (const k of keys) fails.delete(k);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, f] of fails) if (f.until < now && now - f.first > 3600e3) fails.delete(k);
}, 600e3).unref();

export const clientIp = (req) => {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
};

// Владелец создаётся при первом запуске.
export async function ensureOwner() {
  const have = sql("SELECT id FROM users WHERE role = 'owner'").get();
  if (have) return false;
  sql('INSERT INTO users (login, login_key, name, pass, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(OWNER_LOGIN, loginKey(OWNER_LOGIN), OWNER_LOGIN, await hashPassword(OWNER_PASSWORD), 'owner', Date.now());
  setSetting('ownerDefaultPass', true); // пока пароль стандартный, сайт напоминает его сменить
  log(`создан владелец: логин «${OWNER_LOGIN}», пароль ${OWNER_PASSWORD} (смени его в настройках)`);
  return true;
}
