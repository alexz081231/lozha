// Связь с сервером: HTTP-запросы, живые события (WebSocket, при неудаче — SSE + POST), общее состояние.
import { emitter } from './util.js';

export const bus = emitter();

export const store = {
  app: 'Ложа',
  me: null,
  can: { films: false, music: false },
  ytdlp: true,
  secure: false,
  warnPass: false, // у владельца всё ещё пароль по умолчанию
  media: new Map(),
  mediaLoaded: false,
  rooms: [],
  music: null, // состояние музыкальной комнаты
  online: new Set(),
};

export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data || {}; }
}

export async function api(method, url, body, opts = {}) {
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    if (opts.raw) { init.body = body; init.headers['content-type'] = opts.type || 'application/octet-stream'; }
    else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  }
  let res;
  try { res = await fetch(url, init); } catch { throw new ApiError(0, 'Нет связи с сервером'); }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401 && !opts.quiet) bus.emit('unauthorized');
    throw new ApiError(res.status, data?.error || `Ошибка ${res.status}`, data);
  }
  return data;
}
export const get = (u, o) => api('GET', u, undefined, o);
export const post = (u, b = {}, o) => api('POST', u, b, o);
export const patch = (u, b = {}, o) => api('PATCH', u, b, o);
export const del = (u, o) => api('DELETE', u, undefined, o);
export const put = (u, b, o) => api('PUT', u, b, o);

export async function loadMe() {
  const me = await get('/api/me', { quiet: true });
  store.app = me.app || store.app;
  store.me = me.user;
  store.can = me.can || { films: false, music: false };
  store.ytdlp = me.ytdlp;
  store.secure = me.secure;
  store.warnPass = !!me.warnPass;
  if (me.now) rt.offset = me.now - Date.now();
  return me;
}

export async function loadMedia() {
  const { media } = await get('/api/media');
  store.media = new Map(media.map((m) => [m.id, m]));
  store.mediaLoaded = true;
  bus.emit('media:reset');
}

export const films = () => [...store.media.values()].filter((m) => m.kind === 'video').sort((a, b) => b.createdAt - a.createdAt);
export const tracks = () => [...store.media.values()].filter((m) => m.kind === 'audio').sort((a, b) => b.createdAt - a.createdAt);

// ── Живые события ─────────────────────────────────────────────────────────
export const rt = {
  ws: null,
  es: null,
  mode: 'ws',
  open: false,
  cid: null,
  offset: 0, // serverTime − clientTime
  rtt: 0,
  fails: 0,
  everWs: false,
  stopped: true,
  out: [],
  flushTimer: null,
  retryTimer: null,
  syncTimer: null,
  round: [],

  now() { return Date.now() + this.offset; },

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  },

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.syncTimer);
    try { this.ws?.close(); } catch {}
    try { this.es?.close(); } catch {}
    this.ws = this.es = null;
    this.setOpen(false);
  },

  connect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    if (this.mode === 'sse') return this.connectSSE();
    let opened = false;
    let ws;
    try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`); } catch { return this.failed(false); }
    this.ws = ws;
    const timer = setTimeout(() => { if (!opened) { try { ws.close(); } catch {} } }, 7000);
    ws.onopen = () => { opened = true; clearTimeout(timer); this.everWs = true; this.fails = 0; };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } this.handle(m); };
    ws.onclose = () => {
      clearTimeout(timer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.setOpen(false);
      this.failed(opened);
    };
    ws.onerror = () => {};
  },

  // Некоторые телефоны не пускают WebSocket к самоподписанному сертификату — тогда работаем через SSE.
  connectSSE() {
    const es = new EventSource('/api/rt/stream');
    this.es = es;
    es.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } this.fails = 0; this.handle(m); };
    es.onerror = () => {
      if (this.es !== es) return;
      es.close();
      this.es = null;
      this.setOpen(false);
      this.failed(false);
    };
  },

  failed(wasOpen) {
    if (this.stopped) return;
    if (!wasOpen) {
      this.fails++;
      if (this.mode === 'ws' && !this.everWs && this.fails >= 2) { this.mode = 'sse'; this.fails = 0; }
      if (this.fails % 3 === 0) { // возможно, сессия кончилась
        fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()).then((me) => { if (me && !me.user) bus.emit('unauthorized'); }).catch(() => {});
      }
    }
    const delay = wasOpen ? 400 : Math.min(8000, 500 * 2 ** Math.min(this.fails, 5)) * (0.7 + Math.random() * 0.6);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  },

  setOpen(v) {
    if (this.open === v) return;
    this.open = v;
    if (!v) this.cid = null;
    bus.emit('rt', v);
  },

  send(obj) {
    if (!this.open) return false;
    if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; }
    if (this.es && this.cid) {
      this.out.push(obj);
      if (obj.t === 'ping') { clearTimeout(this.flushTimer); this.flush(); } // сверку часов не задерживаем
      else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 25);
      return true;
    }
    return false;
  },

  flush() {
    this.flushTimer = null;
    const msgs = this.out.splice(0);
    if (!msgs.length || !this.cid) return;
    fetch('/api/rt/send', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cid: this.cid, msgs }),
    }).then((r) => { if (r.status === 410 && this.es) { this.es.close(); this.es = null; this.setOpen(false); this.failed(false); } }).catch(() => {});
  },

  // Сверка часов: берём замер с наименьшей задержкой.
  sync(burst = 4) {
    this.round = [];
    for (let i = 0; i < burst; i++) setTimeout(() => this.send({ t: 'ping', c: Date.now() }), i * 160);
  },

  handle(m) {
    switch (m.t) {
      case 'hello':
        this.cid = m.cid;
        this.offset = m.now - Date.now();
        this.setOpen(true);
        this.sync();
        clearInterval(this.syncTimer);
        this.syncTimer = setInterval(() => this.sync(3), 20000);
        bus.emit('rt:hello');
        return;
      case 'pong': {
        const now = Date.now();
        const rtt = now - m.c;
        this.round.push({ rtt, offset: m.s - (m.c + rtt / 2) });
        const best = this.round.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        this.offset = best.offset;
        this.rtt = best.rtt;
        return;
      }
      case 'media':
        store.media.set(m.media.id, m.media);
        bus.emit('media', m.media);
        return;
      case 'media:gone':
        store.media.delete(m.id);
        bus.emit('media:gone', m.id);
        return;
      case 'rooms':
        store.rooms = m.list || [];
        bus.emit('rooms');
        return;
      case 'presence':
        store.online = new Set(m.online || []);
        bus.emit('presence');
        return;
      case 'room:state':
        if (m.room === 'music') { store.music = m; bus.emit('music', m); }
        bus.emit('room:state', m);
        return;
      default:
        bus.emit(m.t, m);
    }
  },
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden || rt.stopped) return;
  if (!rt.open && !rt.ws && !rt.es) rt.connect();
  else if (rt.open) rt.sync(3);
});
window.addEventListener('online', () => { if (!rt.stopped && !rt.open && !rt.ws && !rt.es) rt.connect(); });
