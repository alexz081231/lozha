// Загрузка файлов: куски по 8 МБ, несколько параллельно, докачка после обрыва и перезагрузки страницы.
import { emitter, isMobile } from './util.js';
import { get, post, del } from './api.js';

const PARALLEL = isMobile ? 2 : 5; // на телефоне меньше
let seq = 0;

class Upload {
  constructor(file, kind) {
    this.id = ++seq;
    this.file = file;
    this.kind = kind;
    this.name = file.name;
    this.size = file.size;
    this.status = 'starting'; // starting | uploading | waiting | finishing | done | error | cancelled
    this.error = '';
    this.speed = 0;
    this.sid = null;
    this.chunkSize = 0;
    this.total = 0;
    this.done = new Set();
    this.queue = [];
    this.active = new Map(); // номер куска → { xhr, loaded, at }
    this.samples = [];
    this.timers = new Set();
    this.cancelled = false;
  }

  len(i) { return i === this.total - 1 ? this.size - i * this.chunkSize : this.chunkSize; }

  get bytes() {
    let b = 0;
    for (const i of this.done) b += this.len(i);
    for (const a of this.active.values()) b += a.loaded;
    return Math.min(b, this.size);
  }
  get progress() { return this.size ? (this.bytes / this.size) * 100 : 0; }
  get eta() { return this.speed > 0 ? (this.size - this.bytes) / this.speed : 0; }
  get busy() { return ['starting', 'uploading', 'waiting', 'finishing'].includes(this.status); }

  async start() {
    try {
      const r = await post('/api/uploads', { name: this.name, size: this.size, mtime: this.file.lastModified || 0, kind: this.kind });
      if (this.cancelled) { del(`/api/uploads/${r.id}`).catch(() => {}); return; }
      this.sid = r.id;
      this.chunkSize = r.chunkSize;
      this.total = r.total;
      this.done = new Set(r.received);
      this.resumed = r.resumed;
      this.queue = [];
      for (let i = 0; i < this.total; i++) if (!this.done.has(i)) this.queue.push(i);
      this.status = 'uploading';
      uploads.pending = uploads.pending.filter((p) => p.id !== this.sid);
      this.ticker = setInterval(() => this.tick(), 500);
      uploads.changed();
      if (!this.queue.length) return this.finish();
      this.pump();
    } catch (e) { this.fail(e.message); }
  }

  pump() {
    while (!this.cancelled && ['uploading', 'waiting'].includes(this.status) && this.active.size < PARALLEL && this.queue.length) {
      this.send(this.queue.shift(), 0);
    }
  }

  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.cancelled) fn(); }, ms);
    this.timers.add(t);
  }

  send(i, attempt) {
    const xhr = new XMLHttpRequest();
    const slot = { xhr, loaded: 0, at: Date.now() };
    this.active.set(i, slot);
    const retry = () => {
      if (this.active.get(i) !== slot) return;
      this.active.delete(i);
      if (this.cancelled || !this.busy) return;
      this.status = 'waiting'; // связь пропала — ждём и пробуем снова, пока не отменят
      uploads.changed();
      this.later(() => { this.send(i, attempt + 1); }, navigator.onLine === false ? 2500 : Math.min(15000, 700 * 2 ** Math.min(attempt, 5)));
    };
    xhr.open('PUT', `/api/uploads/${this.sid}/${i}`);
    xhr.upload.onprogress = (e) => { slot.loaded = e.loaded; slot.at = Date.now(); };
    xhr.onload = () => {
      if (this.active.get(i) !== slot) return;
      if (xhr.status === 200) {
        this.active.delete(i);
        this.done.add(i);
        if (this.status === 'waiting') this.status = 'uploading';
        if (this.done.size === this.total) this.finish(); else this.pump();
      } else if ([401, 403, 404].includes(xhr.status)) {
        let msg = 'Загрузка прервана';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        this.fail(msg);
      } else retry();
    };
    xhr.onerror = retry;
    xhr.ontimeout = retry;
    slot.retry = retry;
    const from = i * this.chunkSize;
    xhr.send(this.file.slice(from, from + this.len(i)));
  }

  async finish() {
    if (this.cancelled) return;
    this.status = 'finishing';
    uploads.changed();
    try {
      const r = await post(`/api/uploads/${this.sid}/complete`);
      this.status = 'done';
      this.mediaId = r.mediaId;
      this.cleanup();
      uploads.remove(this);
    } catch (e) {
      if (e.status === 409 && e.data?.missing?.length) {
        for (const i of e.data.missing) { this.done.delete(i); this.queue.push(i); }
        this.status = 'uploading';
        this.pump();
      } else if (e.status === 0 || e.status >= 500) {
        this.status = 'waiting';
        uploads.changed();
        this.later(() => this.finish(), 2500);
      } else this.fail(e.message);
    }
  }

  // Скорость — сглаженная: окно в 5 секунд плюс экспоненциальное усреднение, без скачков «30 МБ/с → 100 КБ/с».
  tick() {
    const now = Date.now();
    const b = this.bytes;
    this.samples.push({ t: now, b });
    while (this.samples.length > 2 && now - this.samples[0].t > 5000) this.samples.shift();
    const first = this.samples[0];
    if (now - first.t >= 900) {
      const raw = Math.max(0, ((b - first.b) / (now - first.t)) * 1000);
      this.speed = this.speed ? this.speed * 0.8 + raw * 0.2 : raw;
    }
    // Кусок завис без движения — перезапускаем его.
    for (const [, slot] of this.active) {
      if (now - slot.at > 45000) { try { slot.xhr.abort(); } catch {} slot.retry(); }
    }
    uploads.changed();
  }

  cleanup() {
    clearInterval(this.ticker);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  fail(msg) {
    this.status = 'error';
    this.error = msg || 'Не удалось загрузить файл';
    for (const a of this.active.values()) { try { a.xhr.abort(); } catch {} }
    this.active.clear();
    this.cleanup();
    uploads.changed();
  }

  cancel() {
    this.cancelled = true;
    this.status = 'cancelled';
    for (const a of this.active.values()) { try { a.xhr.abort(); } catch {} }
    this.active.clear();
    this.cleanup();
    if (this.sid) del(`/api/uploads/${this.sid}`).catch(() => {});
    uploads.remove(this);
  }
}

export const uploads = {
  list: [],
  pending: [], // начатые раньше: файл нужно выбрать снова, и загрузка продолжится
  events: emitter(),

  changed() { this.events.emit('change'); },

  add(file, kind) {
    const dup = this.list.find((u) => u.busy && u.name === file.name && u.size === file.size && u.kind === kind);
    if (dup) return dup;
    const u = new Upload(file, kind);
    this.list.push(u);
    this.changed();
    u.start();
    return u;
  },

  remove(u) {
    this.list = this.list.filter((x) => x !== u);
    this.changed();
  },

  async loadPending() {
    try {
      const { uploads: list } = await get('/api/uploads');
      const activeIds = new Set(this.list.map((u) => u.sid));
      this.pending = list.filter((p) => !activeIds.has(p.id));
      this.changed();
    } catch {}
  },

  async dropPending(id) {
    this.pending = this.pending.filter((p) => p.id !== id);
    this.changed();
    try { await del(`/api/uploads/${id}`); } catch {}
  },
};

addEventListener('beforeunload', (e) => {
  if (uploads.list.some((u) => u.busy)) { e.preventDefault(); e.returnValue = ''; }
});
