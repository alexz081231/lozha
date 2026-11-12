// Живые события: WebSocket (+ запасной канал SSE/POST для упрямых телефонов).
import { WebSocketServer } from 'ws';
import { currentUser, wsOriginOk, publicUser } from './auth.js';
import { sql } from './db.js';
import { rid, log } from './util.js';

export const conns = new Map(); // id → соединение
const handlers = new Map();
const closeHooks = [];
const openHooks = [];

export const on = (type, fn) => handlers.set(type, fn);
export const onClose = (fn) => closeHooks.push(fn);
export const onOpen = (fn) => openHooks.push(fn);

export function broadcast(msg, filter) {
  const raw = JSON.stringify(msg);
  for (const c of conns.values()) if (!filter || filter(c)) c.raw(raw);
}
export function toUser(userId, msg) {
  broadcast(msg, (c) => c.user.id === userId);
}
export function toOwners(msg) {
  broadcast(msg, (c) => c.user.role === 'owner');
}
export function onlineIds() {
  return [...new Set([...conns.values()].map((c) => c.user.id))];
}
export function dropUser(userId, reason = 'Сессия завершена') {
  for (const c of [...conns.values()]) if (c.user.id === userId) c.kick(reason);
}
export function dropSession(sid) {
  for (const c of [...conns.values()]) if (c.sid === sid) c.kick('Вы вышли из аккаунта');
}
export function dropUserExcept(userId, keepSid) {
  for (const c of [...conns.values()]) if (c.user.id === userId && c.sid !== keepSid) c.kick('Вы вышли на всех устройствах');
}
// После смены имени или аватара обновляем данные во всех соединениях.
export function refreshUser(userId) {
  const u = sql('SELECT id, login, name, role, avatar FROM users WHERE id = ?').get(userId);
  if (!u) return;
  const pub = publicUser(u);
  for (const c of conns.values()) if (c.user.id === userId) Object.assign(c.user, pub);
}

function presence() {
  toOwners({ t: 'presence', online: onlineIds() });
}

function dispatch(conn, msg) {
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t === 'ping') return conn.send({ t: 'pong', c: msg.c, s: Date.now() });
  const fn = handlers.get(msg.t);
  if (!fn) return;
  try { fn(conn, msg); } catch (e) { log('ошибка обработчика', msg.t, e); }
}

function register(conn) {
  const first = !onlineIds().includes(conn.user.id);
  conns.set(conn.id, conn);
  conn.send({ t: 'hello', cid: conn.id, now: Date.now() });
  for (const fn of openHooks) { try { fn(conn); } catch (e) { log('ошибка onOpen', e); } }
  if (first) presence();
}

function unregister(conn) {
  if (!conns.delete(conn.id)) return;
  for (const fn of closeHooks) { try { fn(conn); } catch (e) { log('ошибка onClose', e); } }
  if (!onlineIds().includes(conn.user.id)) presence();
}

function makeConn(req, user, kind) {
  return {
    id: rid(8),
    kind,
    user: publicUser(user),
    sid: user.sid,
    room: null,
    alive: true,
    mobile: /Mobi|Android|iPhone|iPad/i.test(String(req.headers['user-agent'] || '')),
    send(obj) { this.raw(JSON.stringify(obj)); },
    raw() {},
    kick() {},
  };
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
let beat = null;

export function attach(server) {
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://local').pathname; } catch {}
    if (pathname !== '/ws') return socket.destroy();
    const user = wsOriginOk(req) ? currentUser(req) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = makeConn(req, user, 'ws');
      conn.raw = (s) => { if (ws.readyState === 1) ws.send(s); };
      conn.kick = (reason) => { try { conn.send({ t: 'bye', reason }); ws.close(4001, 'bye'); } catch {} };
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        conn.alive = true;
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        dispatch(conn, msg);
      });
      ws.on('pong', () => { conn.alive = true; });
      ws.on('close', () => unregister(conn));
      ws.on('error', () => {});
      conn.ws = ws;
      register(conn);
    });
  });

  if (beat) return;
  beat = setInterval(() => {
    for (const c of conns.values()) {
      if (c.kind === 'ws') {
        if (!c.alive) { try { c.ws.terminate(); } catch {} continue; }
        c.alive = false;
        try { c.ws.ping(); } catch {}
      } else if (c.kind === 'sse') {
        if (Date.now() - c.lastIn > 70000) { c.kick(); continue; }
        try { c.res.write(': ok\n\n'); } catch {}
      }
    }
  }, 25000);
  beat.unref();
}

// ── Запасной транспорт: SSE на приём, POST на отправку ────────────────────
export function sseOpen(req, res, user) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const conn = makeConn(req, user, 'sse');
  conn.res = res;
  conn.lastIn = Date.now();
  conn.raw = (s) => { try { res.write(`data: ${s}\n\n`); } catch {} };
  conn.kick = (reason) => { try { if (reason) conn.send({ t: 'bye', reason }); res.end(); } catch {} unregister(conn); };
  req.on('close', () => unregister(conn));
  register(conn);
}

export function sseSend(user, cid, msgs) {
  const conn = conns.get(cid);
  if (!conn || conn.kind !== 'sse' || conn.user.id !== user.id) return false;
  conn.lastIn = Date.now();
  for (const m of Array.isArray(msgs) ? msgs.slice(0, 50) : []) dispatch(conn, m);
  return true;
}
