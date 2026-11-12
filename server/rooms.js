// Комнаты: состояние воспроизведения живёт на сервере, клиенты под него подстраиваются.
// Фильмы — по комнате на фильм; музыка — одна общая комната с очередью.
import * as hub from './hub.js';
import { getMedia } from './library.js';
import { getSetting, setSetting } from './db.js';
import { rid, clamp, log } from './util.js';

const SEEK_HOLD = 7000; // сколько ждём всех после перемотки
const STALL_HOLD = 20000; // сколько ждём того, у кого видео подвисло
const EMPTY_TTL = 20 * 60e3; // пустая комната закрывается сама
const CHAT_KEEP = 200;
const REACTIONS = new Set(['😂', '❤️', '👍', '😮', '😢', '🔥', '👏', '🎉']);

export const rooms = new Map();
let music = null;

let summaryTimer = null;
function scheduleSummary() {
  if (summaryTimer) return;
  summaryTimer = setTimeout(() => { summaryTimer = null; hub.broadcast({ t: 'rooms', list: roomsSummary() }); }, 150);
}
let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 3000);
}
function save() {
  try {
    setSetting('rooms', [...rooms.values()].filter((r) => r.kind === 'film')
      .map((r) => ({ id: r.id, mediaId: r.mediaId, position: r.pos(), rate: r.rate, createdAt: r.createdAt })));
    setSetting('music', { queue: music.queue, current: music.current, position: music.pos() });
  } catch (e) { log('не удалось сохранить комнаты:', e.message); }
}

class Room {
  constructor(id, kind, mediaId = null) {
    this.id = id;
    this.kind = kind;
    this.mediaId = mediaId;
    this.playing = false;
    this.position = 0;
    this.rate = 1;
    this.updatedAt = Date.now();
    this.seq = 1;
    this.waiting = false;
    this.holdSeq = 0;
    this.waitFor = new Map(); // cid → крайний срок
    this.members = new Map(); // cid → участник
    this.chat = [];
    this.createdAt = Date.now();
    this.emptySince = Date.now();
    this.queue = [];
    this.current = null;
  }

  get duration() { return (this.mediaId && getMedia(this.mediaId)?.duration) || 0; }

  pos(now = Date.now()) {
    let p = this.position;
    if (this.playing && !this.waiting) p += ((now - this.updatedAt) / 1000) * this.rate;
    const d = this.duration;
    return d ? clamp(p, 0, d) : Math.max(0, p);
  }

  freeze() {
    const now = Date.now();
    this.position = this.pos(now);
    this.updatedAt = now;
  }

  state() {
    const out = {
      t: 'room:state', room: this.id, kind: this.kind, mediaId: this.mediaId, playing: this.playing, position: this.position,
      rate: this.rate, updatedAt: this.updatedAt, seq: this.seq, waiting: this.waiting,
      waitingFor: [...new Set([...this.waitFor.keys()].map((cid) => this.members.get(cid)?.conn.user.name).filter(Boolean))],
      now: Date.now(),
    };
    if (this.kind === 'music') { out.queue = this.queue; out.current = this.current; }
    return out;
  }

  send(msg, except) {
    const raw = JSON.stringify(msg);
    for (const m of this.members.values()) if (m.conn !== except) m.conn.raw(raw);
  }

  push() {
    const msg = this.state();
    if (this.kind === 'music') hub.broadcast(msg); else this.send(msg);
    scheduleSummary();
    saveSoon();
  }

  viewers() {
    return [...this.members.entries()].map(([cid, m]) => ({
      cid,
      id: m.conn.user.id,
      name: m.conn.user.name,
      avatar: m.conn.user.avatar,
      role: m.conn.user.role,
      status: m.away ? 'away' : !m.loaded ? 'loading' : (!m.ready || this.waitFor.has(cid)) ? 'buffering' : 'ok',
      voice: m.voice ? { muted: m.voice.muted } : null,
    }));
  }
  pushViewers() {
    this.send({ t: 'room:viewers', room: this.id, viewers: this.viewers() });
    scheduleSummary();
  }

  event(conn, type, data = {}) {
    this.send({ t: 'room:event', room: this.id, type, cid: conn.id, user: { id: conn.user.id, name: conn.user.name }, ...data });
  }

  join(conn) {
    if (conn.room !== this) {
      conn.room?.leave(conn);
      conn.room = this;
      this.members.set(conn.id, { conn, ready: false, loaded: false, away: false, voice: null, times: { chat: [], react: [] } });
      this.emptySince = 0;
      this.event(conn, 'join');
    }
    conn.send({ t: 'room:joined', room: this.id, you: conn.id, state: this.state(), viewers: this.viewers(), chat: this.chat.slice(-100) });
    this.pushViewers();
  }

  leave(conn, { silent = false } = {}) {
    const m = this.members.get(conn.id);
    if (!m) return;
    this.members.delete(conn.id);
    conn.room = null;
    if (m.voice) this.send({ t: 'voice:left', cid: conn.id });
    if (!silent) this.event(conn, 'leave');
    if (this.waitFor.delete(conn.id)) this.checkWait();
    if (!this.members.size) {
      this.emptySince = Date.now();
      if (this.playing) { // никого не осталось — ставим на паузу, чтобы не убежало
        this.freeze();
        this.playing = false;
        this.waiting = false;
        this.waitFor.clear();
        this.seq++;
        this.push();
      }
    }
    this.pushViewers();
  }

  holdAll(ms) {
    const until = Date.now() + ms;
    this.waitFor.clear();
    for (const [cid, m] of this.members) if (m.loaded && !m.away) this.waitFor.set(cid, until);
    this.waiting = this.waitFor.size > 0;
    this.holdSeq = this.seq + 1;
  }

  checkWait() {
    if (!this.waiting) return;
    const now = Date.now();
    for (const [cid, until] of this.waitFor) if (until <= now || !this.members.has(cid)) this.waitFor.delete(cid);
    if (this.waitFor.size) return;
    this.waiting = false;
    this.updatedAt = Date.now();
    this.seq++;
    this.push();
    this.pushViewers();
  }

  control(conn, m) {
    if (!this.members.has(conn.id) || !this.mediaId) return;
    const now = Date.now();
    const d = this.duration;
    switch (m.action) {
      case 'play':
        if (this.playing) return;
        this.freeze();
        if (d && this.position >= d - 0.5) this.position = 0; // досмотрели — начинаем заново
        this.playing = true;
        this.updatedAt = now;
        this.event(conn, 'play');
        break;
      case 'pause':
        if (!this.playing) return;
        this.freeze();
        this.playing = false;
        this.waiting = false;
        this.waitFor.clear();
        this.event(conn, 'pause', { position: this.position });
        break;
      case 'seek': {
        const p = clamp(Number(m.position) || 0, 0, d ? Math.max(0, d - 0.25) : 1e7);
        this.position = p;
        this.updatedAt = now;
        if (this.playing) this.holdAll(SEEK_HOLD); // ждём, пока у всех подгрузится новое место
        this.event(conn, 'seek', { position: p });
        break;
      }
      case 'rate': {
        const r = clamp(Number(m.rate) || 1, 0.25, 3);
        if (r === this.rate) return;
        this.freeze();
        this.rate = r;
        this.event(conn, 'rate', { rate: r });
        break;
      }
      default:
        return;
    }
    this.seq++;
    this.push();
  }

  // Клиент сообщает, готово ли у него видео к показу с текущего места.
  status(conn, m) {
    const mem = this.members.get(conn.id);
    if (!mem) return;
    let changed = false;
    if (typeof m.away === 'boolean' && mem.away !== m.away) {
      mem.away = m.away;
      changed = true;
      if (m.away && this.waitFor.delete(conn.id)) this.checkWait();
    }
    if (m.ready === true) {
      if (!mem.ready || !mem.loaded) changed = true;
      mem.ready = true;
      mem.loaded = true;
      if (this.waitFor.has(conn.id) && (Number(m.seq) || 0) >= this.holdSeq) {
        this.waitFor.delete(conn.id);
        this.checkWait();
        changed = true;
      }
    } else if (m.ready === false) {
      if (mem.ready) changed = true;
      mem.ready = false;
      // У кого-то видео подвисло — комната ждёт его.
      if (this.playing && mem.loaded && !mem.away && !this.waitFor.has(conn.id)) {
        if (!this.waiting) {
          this.freeze();
          this.waiting = true;
          this.holdSeq = this.seq + 1;
        }
        this.waitFor.set(conn.id, Date.now() + STALL_HOLD);
        this.seq++;
        this.push();
        changed = true;
      }
    }
    if (changed) this.pushViewers();
  }

  limited(mem, what, max, per = 5000) {
    const now = Date.now();
    const list = (mem.times[what] = mem.times[what].filter((t) => now - t < per));
    if (list.length >= max) return true;
    list.push(now);
    return false;
  }

  say(conn, text) {
    const mem = this.members.get(conn.id);
    if (!mem) return;
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!text) return;
    if (this.limited(mem, 'chat', 6)) return conn.send({ t: 'toast', text: 'Чуть помедленнее' });
    const msg = {
      id: rid(6),
      user: { id: conn.user.id, name: conn.user.name, avatar: conn.user.avatar },
      text,
      at: this.mediaId ? Math.floor(this.pos()) : null, // момент фильма
      ts: Date.now(),
    };
    this.chat.push(msg);
    if (this.chat.length > CHAT_KEEP) this.chat.shift();
    this.send({ t: 'room:chat', room: this.id, msg });
  }

  react(conn, emoji) {
    const mem = this.members.get(conn.id);
    if (!mem || !REACTIONS.has(emoji) || this.limited(mem, 'react', 14)) return;
    this.send({ t: 'room:react', room: this.id, emoji, user: { id: conn.user.id, name: conn.user.name } });
  }

  setMedia(conn, mediaId) {
    const m = getMedia(mediaId);
    if (!m || m.kind !== 'video' || m.status !== 'ready') return conn.send({ t: 'toast', text: 'Этот фильм ещё не готов' });
    if (mediaId === this.mediaId) return;
    const other = [...rooms.values()].find((r) => r !== this && r.kind === 'film' && r.mediaId === mediaId);
    if (other && other.members.size) return conn.send({ t: 'toast', text: 'Этот фильм уже идёт в другой комнате', room: other.id });
    if (other) closeRoom(other, null); // пустая комната этого фильма больше не нужна
    this.mediaId = mediaId;
    this.position = 0;
    this.updatedAt = Date.now();
    this.playing = false;
    this.waiting = false;
    this.waitFor.clear();
    this.rate = 1;
    for (const mem of this.members.values()) { mem.ready = false; mem.loaded = false; }
    this.seq++;
    this.event(conn, 'media', { title: m.title });
    this.push();
    this.pushViewers();
  }

  tick(now) {
    if (this.waiting) this.checkWait();
    if (this.playing && !this.waiting && this.mediaId) {
      const d = this.duration;
      if (d && this.pos(now) >= d - 0.05) this.ended();
    }
    if (this.kind === 'film' && !this.members.size && this.emptySince && now - this.emptySince > EMPTY_TTL) closeRoom(this, null);
  }

  ended() {
    if (this.kind === 'music') return this.advance(1, true);
    this.position = this.duration;
    this.updatedAt = Date.now();
    this.playing = false;
    this.seq++;
    this.push();
  }

  // ── Голос (сигнальный канал для WebRTC) ──────────────────────────────────
  voiceJoin(conn, m) {
    const mem = this.members.get(conn.id);
    if (!mem) return;
    const peers = [...this.members].filter(([cid, x]) => x.voice && cid !== conn.id).map(([cid]) => cid);
    mem.voice = { muted: !!m.muted, speaking: false };
    conn.send({ t: 'voice:peers', peers });
    this.pushViewers();
  }
  voiceLeave(conn) {
    const mem = this.members.get(conn.id);
    if (!mem?.voice) return;
    mem.voice = null;
    this.send({ t: 'voice:left', cid: conn.id }, conn);
    this.pushViewers();
  }
  voiceSignal(conn, m) {
    const me = this.members.get(conn.id);
    const to = this.members.get(m.to);
    if (!me?.voice || !to?.voice) return;
    to.conn.send({ t: 'voice:signal', from: conn.id, data: m.data });
  }
  voiceState(conn, m) {
    const mem = this.members.get(conn.id);
    if (!mem?.voice) return;
    const muted = !!m.muted;
    const speaking = !!m.speaking && !muted;
    const mutedChanged = mem.voice.muted !== muted;
    mem.voice.muted = muted;
    mem.voice.speaking = speaking;
    this.send({ t: 'voice:state', cid: conn.id, uid: conn.user.id, muted, speaking });
    if (mutedChanged) this.pushViewers();
  }

  // ── Очередь (музыка) ─────────────────────────────────────────────────────
  qIndex(qid) { return this.queue.findIndex((x) => x.qid === qid); }

  setCurrent(qid, { play = true } = {}) {
    const item = this.queue.find((x) => x.qid === qid) || null;
    this.current = item ? item.qid : null;
    this.mediaId = item ? item.trackId : null;
    this.position = 0;
    this.updatedAt = Date.now();
    this.rate = 1;
    this.playing = !!item && play && this.members.size > 0;
    this.waiting = false;
    this.waitFor.clear();
    for (const mem of this.members.values()) mem.ready = false;
    if (this.playing) this.holdAll(SEEK_HOLD); // стартуем, когда у всех загрузится трек
    this.seq++;
    this.push();
  }

  add(conn, trackId, mode = 'end') {
    const t = getMedia(trackId);
    if (!t || t.kind !== 'audio' || t.status !== 'ready') return;
    if (this.queue.length >= 500) return conn.send({ t: 'toast', text: 'Очередь переполнена' });
    const item = { qid: rid(6), trackId, by: conn.user.id };
    const ci = this.qIndex(this.current);
    if (mode === 'end' || ci < 0) this.queue.push(item);
    else this.queue.splice(ci + 1, 0, item);
    if (mode === 'now' || this.current == null) return this.setCurrent(item.qid, { play: true });
    this.seq++;
    this.push();
  }

  remove(qid) {
    const i = this.qIndex(qid);
    if (i < 0) return;
    const wasCurrent = this.current === qid;
    const wasPlaying = this.playing;
    this.queue.splice(i, 1);
    if (wasCurrent) return this.setCurrent(this.queue[i]?.qid ?? this.queue[0]?.qid ?? null, { play: wasPlaying && !!this.queue[i] });
    this.seq++;
    this.push();
  }

  move(qid, to) {
    const i = this.qIndex(qid);
    if (i < 0) return;
    const [it] = this.queue.splice(i, 1);
    this.queue.splice(clamp(Math.round(Number(to) || 0), 0, this.queue.length), 0, it);
    this.seq++;
    this.push();
  }

  advance(dir, auto = false) {
    const i = this.qIndex(this.current);
    if (i < 0) return;
    if (dir < 0 && (this.pos() > 3 || i === 0)) { // «назад» посреди трека — к его началу
      this.position = 0;
      this.updatedAt = Date.now();
      if (this.playing) this.holdAll(SEEK_HOLD);
      this.seq++;
      return this.push();
    }
    const next = this.queue[i + dir];
    if (next) return this.setCurrent(next.qid, { play: true });
    if (auto) return this.setCurrent(this.queue[0]?.qid ?? null, { play: false }); // очередь кончилась
  }
}

// ── Публичное ─────────────────────────────────────────────────────────────
export function roomsSummary() {
  const list = [];
  for (const r of rooms.values()) {
    if (!r.members.size || !r.mediaId) continue;
    const m = getMedia(r.mediaId);
    if (!m) continue;
    const users = new Map();
    for (const mem of r.members.values()) {
      const u = mem.conn.user;
      users.set(u.id, { id: u.id, name: u.name, avatar: u.avatar });
    }
    list.push({
      id: r.id, kind: r.kind, mediaId: r.mediaId, title: m.title, artist: m.artist || '',
      poster: m.poster ? `/media/${m.id}/poster.jpg?v=${m.poster}` : '',
      duration: m.duration || 0, playing: r.playing && !r.waiting, position: r.pos(), rate: r.rate, at: Date.now(),
      viewers: [...users.values()],
    });
  }
  return list;
}

// Один фильм — одна комната: повторное «Смотреть» возвращает уже идущую.
export function openRoom(mediaId, user) {
  const m = getMedia(mediaId);
  if (!m || m.kind !== 'video') return { error: 'Фильм не найден' };
  if (m.status !== 'ready') return { error: 'Фильм ещё не готов' };
  for (const r of rooms.values()) if (r.kind === 'film' && r.mediaId === mediaId) return { id: r.id, created: false };
  const room = new Room(rid(6), 'film', mediaId);
  rooms.set(room.id, room);
  saveSoon();
  // Друзья, которые сейчас на сайте, узнают, что владелец начал смотреть.
  hub.broadcast({
    t: 'notify', type: 'watch', room: room.id, title: m.title, by: user.name,
    poster: m.poster ? `/media/${m.id}/poster.jpg?v=${m.poster}` : '',
  }, (c) => c.user.id !== user.id);
  return { id: room.id, created: true };
}

export function roomFor(mediaId) {
  for (const r of rooms.values()) if (r.kind === 'film' && r.mediaId === mediaId) return r.id;
  return null;
}

export function closeRoom(room, by) {
  room.send({ t: 'room:closed', room: room.id, by: by?.user.name || '' });
  for (const m of room.members.values()) m.conn.room = null;
  room.members.clear();
  rooms.delete(room.id);
  scheduleSummary();
  saveSoon();
}

export function onMediaRemoved(id) {
  for (const r of [...rooms.values()]) {
    if (r.kind === 'film' && r.mediaId === id) closeRoom(r, null);
  }
  if (music.queue.some((x) => x.trackId === id)) {
    const cur = music.queue.find((x) => x.qid === music.current);
    const wasCurrent = cur?.trackId === id;
    const idx = music.qIndex(music.current);
    const after = music.queue.slice(idx + 1).find((x) => x.trackId !== id);
    music.queue = music.queue.filter((x) => x.trackId !== id);
    if (wasCurrent) music.setCurrent(after?.qid ?? music.queue[0]?.qid ?? null, { play: music.playing && !!after });
    else { music.seq++; music.push(); }
  }
}

export function initRooms() {
  music = new Room('music', 'music');
  rooms.set('music', music);

  // Восстановление после перезапуска: всё на паузе, на прежнем месте.
  for (const s of getSetting('rooms', []) || []) {
    const m = getMedia(s.mediaId);
    if (!m || m.kind !== 'video' || m.status !== 'ready' || rooms.has(s.id)) continue;
    const r = new Room(s.id, 'film', s.mediaId);
    r.position = clamp(Number(s.position) || 0, 0, m.duration || 0);
    r.rate = clamp(Number(s.rate) || 1, 0.25, 3);
    r.createdAt = s.createdAt || Date.now();
    rooms.set(r.id, r);
  }
  const ms = getSetting('music', null);
  if (ms?.queue) {
    music.queue = ms.queue.filter((x) => x && getMedia(x.trackId)?.status === 'ready');
    const cur = music.queue.find((x) => x.qid === ms.current) || music.queue[0];
    if (cur) {
      music.current = cur.qid;
      music.mediaId = cur.trackId;
      music.position = cur.qid === ms.current ? clamp(Number(ms.position) || 0, 0, getMedia(cur.trackId).duration || 0) : 0;
    }
  }

  const room = (c, m) => (m.room === 'music' ? music : rooms.get(m.room));
  hub.on('room:join', (c, m) => {
    const r = room(c, m);
    if (!r) return c.send({ t: 'room:gone', room: m.room });
    r.join(c);
  });
  hub.on('room:leave', (c) => c.room?.leave(c));
  hub.on('room:control', (c, m) => c.room?.control(c, m));
  hub.on('room:status', (c, m) => c.room?.status(c, m));
  hub.on('room:chat', (c, m) => c.room?.say(c, m.text));
  hub.on('room:react', (c, m) => c.room?.react(c, m.emoji));
  hub.on('room:media', (c, m) => {
    if (c.user.role !== 'owner') return c.send({ t: 'toast', text: 'Менять фильм может только владелец' });
    if (c.room?.kind === 'film') c.room.setMedia(c, m.mediaId);
  });
  hub.on('room:close', (c) => {
    if (c.user.role !== 'owner') return c.send({ t: 'toast', text: 'Закрыть комнату может только владелец' });
    if (c.room?.kind === 'film') closeRoom(c.room, c);
  });

  hub.on('voice:join', (c, m) => c.room?.voiceJoin(c, m));
  hub.on('voice:leave', (c) => c.room?.voiceLeave(c));
  hub.on('voice:signal', (c, m) => c.room?.voiceSignal(c, m));
  hub.on('voice:state', (c, m) => c.room?.voiceState(c, m));

  hub.on('music:add', (c, m) => music.add(c, m.trackId, ['end', 'next', 'now'].includes(m.mode) ? m.mode : 'end'));
  hub.on('music:remove', (c, m) => music.remove(m.qid));
  hub.on('music:move', (c, m) => music.move(m.qid, m.to));
  hub.on('music:jump', (c, m) => { if (music.qIndex(m.qid) >= 0) music.setCurrent(m.qid, { play: true }); });
  hub.on('music:next', () => music.advance(1));
  hub.on('music:prev', () => music.advance(-1));
  hub.on('music:clear', () => { music.queue = []; music.setCurrent(null); });

  hub.onOpen((c) => {
    c.send({ t: 'rooms', list: roomsSummary() });
    c.send(music.state());
  });
  hub.onClose((c) => c.room?.leave(c));

  setInterval(() => {
    const now = Date.now();
    for (const r of [...rooms.values()]) { try { r.tick(now); } catch (e) { log('ошибка комнаты:', e); } }
  }, 400).unref();
}

export function saveRoomsNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (music) save();
}
