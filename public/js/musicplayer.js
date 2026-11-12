// Музыка вместе: общий плеер, который живёт поверх всех страниц (музыка не прерывается при переходах).
import { h, $, fmtTime, img, ls, clamp } from './util.js';
import { icon } from './icons.js';
import { store, bus, rt } from './api.js';
import { toast, seekline, range } from './ui.js';
import { RoomSession, roomPanel, reactionBar, eventText } from './room.js';
import { Voice, voiceBar } from './voice.js';

// Полсекунды тишины: «разблокирует» звук в Safari по первому нажатию.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

const audio = new Audio();
audio.preload = 'auto';

const trackOf = (id) => (id ? store.media.get(id) : null);

export const music = {
  audio,
  joined: false,
  session: null,
  voice: null,
  chat: [],
  viewers: [],
  loadedId: null,
  blocked: false,
  volume: clamp(Number(ls.get('mvol', 1)) || 0, 0, 1),
  duck: 1,
  np: null,
  mini: null,

  get state() { return store.music; },
  get track() { return trackOf(store.music?.mediaId); },
  position() {
    const s = store.music;
    if (!s) return 0;
    if (this.joined && this.loadedId === s.mediaId && audio.duration) return audio.currentTime;
    let p = s.position;
    if (s.playing && !s.waiting) p += ((rt.now() - s.updatedAt) / 1000) * s.rate;
    return Math.min(p, this.track?.duration || p);
  },

  load(id) {
    const t = trackOf(id);
    this.loadedId = id || null;
    if (!t || !t.url) { audio.removeAttribute('src'); audio.load(); return; }
    audio.src = t.url;
    audio.load();
    this.applyVolume();
    this.setMeta(t);
  },

  setMeta(t) {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || 'Ложа', artwork: t.poster ? [{ src: t.poster, sizes: '800x800', type: 'image/jpeg' }] : [] });
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => this.session?.control('play'));
      ms.setActionHandler('pause', () => this.session?.control('pause'));
      ms.setActionHandler('nexttrack', () => this.next());
      ms.setActionHandler('previoustrack', () => this.prev());
      ms.setActionHandler('seekto', (d) => { if (d.seekTime != null) this.seek(d.seekTime); });
    } catch {}
  },

  applyVolume() {
    try { audio.volume = clamp(this.volume * this.duck, 0, 1); } catch {}
  },
  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    ls.set('mvol', this.volume);
    this.applyVolume();
  },

  async play() {
    try { await audio.play(); this.blocked = false; } catch (e) {
      if (e.name === 'NotAllowedError') { this.blocked = true; this.paint(); }
    }
  },

  // Вход в комнату прослушивания. Вызывается по нажатию — так браузер разрешает звук.
  join(hintId) {
    if (this.joined) return;
    if (!rt.open) { toast('Нет связи с сервером'); return; }
    this.joined = true;
    this.blocked = false;
    const id = hintId || store.music?.mediaId;
    if (id && trackOf(id)?.url) { this.load(id); audio.play().catch(() => {}); }
    else { audio.src = SILENCE; audio.play().catch(() => {}); this.loadedId = null; }

    this.voice = new Voice({
      onChange: () => { this.np?.vbar.draw(); this.np?.panel.redraw(); },
      onSpeaking: () => {
        this.np?.panel.setSpeaking(new Set(this.voice.speaking));
        this.duck = this.voice.othersSpeaking() ? 0.35 : 1;
        this.applyVolume();
      },
    });
    this.voice.uidOf = (cid) => this.viewers.find((v) => v.cid === cid)?.id ?? null;

    this.session = new RoomSession('music', {
      getEl: () => (this.loadedId && this.loadedId === store.music?.mediaId ? audio : null),
      play: () => this.play(),
      pause: () => audio.pause(),
      onJoined: (m) => { this.chat = m.chat || []; this.viewers = m.viewers; this.np?.panel.setChat(this.chat); this.np?.panel.setViewers(this.viewers); if (this.voice.joined) { this.voice.leave(true); this.voice.join(); } },
      onState: (s) => {
        if (s.mediaId !== this.loadedId) this.load(s.mediaId);
        if (!s.mediaId) audio.pause();
        this.paint();
      },
      onViewers: (list) => { this.viewers = list; this.np?.panel.setViewers(list); },
      onEvent: (e) => {
        if (e.type === 'join' || e.type === 'leave') { if (e.cid !== rt.cid) this.np?.panel.addSys(eventText(e)); return; }
        if (e.cid !== rt.cid) toast(eventText(e), { timeout: 2000 });
      },
      onChat: (msg) => { this.chat.push(msg); if (this.chat.length > 200) this.chat.shift(); if (this.np) this.np.panel.addChat(msg); else if (msg.user.id !== store.me.id) toast(`${msg.user.name}: ${msg.text.slice(0, 80)}`, { action: { label: 'Чат', fn: () => { this.openNow(); this.np?.panel.setTab('chat'); } }, timeout: 5000 }); },
      onReact: (m) => this.np?.react(m.emoji, m.user.id === store.me.id ? '' : m.user.name),
      onVoice: (m) => this.voice.handle(m),
    });
    this.session.start();
    this.timer = setInterval(() => this.paintTime(), 400);
    this.paint();
    bus.emit('music:joined');
  },

  leave() {
    if (!this.joined) return;
    this.joined = false;
    clearInterval(this.timer);
    this.voice?.leave();
    this.voice = null;
    this.session?.stop();
    this.session = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    this.loadedId = null;
    this.closeNow();
    this.paint();
    bus.emit('music:joined');
  },

  reset() {
    this.leave();
    this.chat = [];
    store.music = null;
  },

  // ── Управление (общее для всех слушателей) ──────────────────────────────
  toggle() {
    const s = store.music;
    if (!s?.mediaId) return;
    if (!this.joined) { // сначала заходим в комнату; если там пауза — запускаем
      this.join();
      if (this.joined && !s.playing) rt.send({ t: 'room:control', action: 'play' });
      return;
    }
    if (this.blocked) { this.play(); return; }
    this.session.control(s.playing ? 'pause' : 'play');
  },
  playNow(trackId) {
    this.join(trackId);
    if (this.joined && this.loadedId !== trackId) { this.load(trackId); audio.play().catch(() => {}); }
    rt.send({ t: 'music:add', trackId, mode: 'now' });
  },
  enqueue(trackId) {
    if (rt.send({ t: 'music:add', trackId, mode: 'end' })) toast('Добавлено в очередь', { timeout: 1500 });
  },
  jump(qid) {
    const it = store.music?.queue.find((x) => x.qid === qid);
    if (!it) return;
    this.join(it.trackId);
    rt.send({ t: 'music:jump', qid });
  },
  next() { rt.send({ t: 'music:next' }); },
  prev() { rt.send({ t: 'music:prev' }); },
  seek(t) { if (this.joined) this.session.control('seek', t); },
  remove(qid) { rt.send({ t: 'music:remove', qid }); },

  // ── Мини-плеер ──────────────────────────────────────────────────────────
  paint() {
    const host = $('#mini');
    const s = store.music;
    const t = this.track;
    const show = this.joined && !!t;
    if (!show) {
      if (this.mini) { const el = this.mini.el; this.mini = null; el.classList.add('out'); setTimeout(() => el.remove(), 300); }
    } else {
      if (!this.mini) {
        const cover = h('div.mini-cover');
        const title = h('div.mini-title.clip'), sub = h('div.mini-sub.clip');
        const playBtn = h('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': 'Играть / пауза', onclick: (e) => { e.stopPropagation(); this.toggle(); } });
        const nextBtn = h('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': 'Следующий', onclick: (e) => { e.stopPropagation(); this.next(); } }, icon('next', 'ic-s'));
        const line = h('i');
        const el = h('div.mini.glass', { role: 'button', tabIndex: 0, onclick: () => this.openNow() }, cover, h('div.grow', title, sub), h('div.mini-ctl', playBtn, nextBtn), h('div.mini-line', line));
        this.mini = { el, cover, title, sub, playBtn, line, poster: null };
        host.append(el);
      }
      const m = this.mini;
      m.title.textContent = t.title;
      m.sub.textContent = this.blocked ? 'нажми ▶, чтобы слушать' : (t.artist || 'Музыка вместе');
      if (m.poster !== t.poster) { m.poster = t.poster; m.cover.replaceChildren(t.poster ? img(t.poster) : icon('music', 'ic-s')); }
      const playing = s.playing && !this.blocked;
      m.cover.classList.toggle('spin-slow', playing && !s.waiting);
      m.playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 'ic-s'));
    }
    this.np?.paint();
    this.paintTime();
  },

  paintTime() {
    // Если сервер не принял наш трек (например, его удалили), возвращаемся к тому, что играет в комнате.
    const want = store.music?.mediaId || null;
    if (this.joined && this.loadedId !== want) {
      this.mismatchAt ||= Date.now();
      if (Date.now() - this.mismatchAt > 3000) { this.mismatchAt = 0; this.load(want); }
    } else this.mismatchAt = 0;
    const t = this.track;
    if (!t) return;
    const pos = this.position();
    if (this.mini) this.mini.line.style.width = `${t.duration ? Math.min(100, (pos / t.duration) * 100) : 0}%`;
    this.np?.line.set(pos, t.duration || 0);
  },

  // ── Экран «Сейчас играет» ───────────────────────────────────────────────
  openNow() {
    if (this.np || !this.joined) return;
    const bg = h('div.np-bg');
    const cover = h('div.np-cover.paused');
    const fx = h('div.np-fx');
    const title = h('div.np-title'), artist = h('div.np-artist');
    const line = seekline({ onSeek: (t) => this.seek(t) });
    const playBtn = h('button.btn.btn-primary.btn-icon.np-play', { type: 'button', 'aria-label': 'Играть / пауза', onclick: () => this.toggle() });
    const vbar = voiceBar(this.voice);
    const vol = range(Math.round(this.volume * 100), { oninput: (v) => this.setVolume(v / 100) });
    let noVol = false;
    try { const was = audio.volume; audio.volume = 0.5; noVol = audio.volume !== 0.5; audio.volume = was; } catch { noVol = true; }
    const queue = queueList();
    const panel = roomPanel({ onSeek: null, who: 'Слушатели', voice: this.voice, extra: [{ key: 'queue', label: 'Очередь', el: queue }] });
    panel.setChat(this.chat);
    panel.setViewers(this.viewers);
    const wrap = h('div.np-wrap', bg,
      h('div.np',
        h('div.np-main',
          h('button.btn.btn-icon.np-close', { type: 'button', 'aria-label': 'Свернуть', onclick: () => this.closeNow() }, icon('chevL')),
          h('div.np-art', { style: { position: 'relative', display: 'grid', placeItems: 'center', width: '100%', flex: 'none' } }, cover, fx),
          h('div.np-info', title, artist),
          line,
          h('div.np-ctl',
            h('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': 'Предыдущий', onclick: () => this.prev() }, icon('prev')),
            playBtn,
            h('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': 'Следующий', onclick: () => this.next() }, icon('next'))),
          h('div.np-row', reactionBar((e) => rt.send({ t: 'room:react', emoji: e })), vbar),
          h('div.np-row', noVol ? null : h('div.row.muted', icon('volLow', 'ic-s'), vol),
            h('button.btn.btn-s.btn-line', { type: 'button', onclick: () => this.leave() }, icon('exit', 'ic-s'), 'Выйти из комнаты'))),
        h('aside.np-side.glass', panel.el)));
    let poster = null;
    const paint = () => {
      const t = this.track, s = store.music;
      if (!t) { title.textContent = 'Очередь пуста'; artist.textContent = 'Добавь трек — он заиграет у всех'; cover.replaceChildren(icon('music')); bg.classList.remove('ok'); poster = null; }
      else {
        title.textContent = t.title;
        artist.textContent = t.artist || '';
        if (poster !== t.poster) {
          poster = t.poster;
          cover.replaceChildren(t.poster ? img(t.poster) : icon('music'));
          bg.style.backgroundImage = t.poster ? `url("${t.poster}")` : '';
          bg.classList.toggle('ok', !!t.poster);
        }
      }
      const playing = !!s?.playing && !this.blocked;
      cover.classList.toggle('paused', !playing);
      playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
    };
    const react = (emoji, name) => {
      const el = h('div.fx-emoji', { style: { left: `${20 + Math.random() * 60}%`, bottom: '10%', '--dx': `${(Math.random() - 0.5) * 140}px`, '--rot': `${(Math.random() - 0.5) * 40}deg` } }, emoji, name ? h('small', name) : null);
      fx.append(el);
      setTimeout(() => el.remove(), 3500);
    };
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.sheet-wrap')) this.closeNow(); };
    document.addEventListener('keydown', onKey);
    this.np = { el: wrap, panel, vbar, line, paint, react, queue, onKey };
    $('#layer').append(wrap);
    document.documentElement.classList.add('locked');
    paint();
    this.paintTime();
    void wrap.offsetWidth;
    wrap.classList.add('in');
  },

  closeNow() {
    const np = this.np;
    if (!np) return;
    this.np = null;
    document.removeEventListener('keydown', np.onKey);
    np.queue.destroy();
    np.el.classList.remove('in');
    np.el.classList.add('out');
    document.documentElement.classList.remove('locked');
    setTimeout(() => np.el.remove(), 260);
  },
};

bus.on('music', () => music.paint());
bus.on('media', (m) => { if (m.kind === 'audio' && m.id === store.music?.mediaId) music.paint(); });
bus.on('media:reset', () => music.paint());

// ── Очередь: порядок меняется перетаскиванием ─────────────────────────────
export function queueList() {
  const el = h('div.queue');
  let dragging = false;

  function render() {
    if (dragging) return;
    const s = store.music;
    const q = s?.queue || [];
    if (!q.length) {
      el.replaceChildren(h('div.chat-empty', 'Очередь пуста. Нажми ▶ на треке — он заиграет у всех, или «+», чтобы поставить его следующим в конец.'));
      return;
    }
    el.replaceChildren(...q.map((it, i) => row(it, i, s)));
  }

  function row(it, i, s) {
    const t = store.media.get(it.trackId);
    const cur = it.qid === s.current;
    const grip = h('button.grip', { type: 'button', 'aria-label': 'Перетащить' }, icon('grip', 'ic-s'));
    const r = h(`div.track${cur ? '.cur' : ''}`, { dataset: { qid: it.qid } },
      h('button.track-cover', { type: 'button', 'aria-label': 'Играть', onclick: () => (cur ? music.toggle() : music.jump(it.qid)) },
        t?.poster ? img(t.poster) : icon('music', 'ic-s'),
        h('span.ov', cur ? h(`span.eq${s.playing ? '' : '.paused'}`, h('i'), h('i'), h('i')) : icon('play', 'ic-s'))),
      h('div', h('div.track-title.clip', t?.title || 'Трек удалён'), h('div.track-sub.clip', t?.artist || '')),
      h('div.track-end', h('span.num', t ? fmtTime(t.duration) : ''),
        h('button.btn.btn-ghost.btn-icon.btn-s', { type: 'button', 'aria-label': 'Убрать из очереди', onclick: () => music.remove(it.qid) }, icon('x', 'ic-s')), grip));
    grip.addEventListener('pointerdown', (e) => startDrag(e, r, it, grip));
    return r;
  }

  function startDrag(e, r, it, grip) {
    e.preventDefault();
    const rows = [...el.querySelectorAll('.track')];
    const from = rows.indexOf(r);
    const step = r.offsetHeight + 2;
    const y0 = e.clientY;
    let to = from;
    dragging = true;
    r.classList.add('dragging');
    try { grip.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => {
      const dy = ev.clientY - y0;
      r.style.transform = `translateY(${dy}px)`;
      to = clamp(Math.round(from + dy / step), 0, rows.length - 1);
      rows.forEach((x, i) => {
        if (x === r) return;
        x.classList.add('shift');
        const off = from < to && i > from && i <= to ? -step : from > to && i >= to && i < from ? step : 0;
        x.style.transform = off ? `translateY(${off}px)` : '';
      });
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      dragging = false;
      if (to !== from && store.music) {
        const q = store.music.queue.slice();
        const [x] = q.splice(from, 1);
        q.splice(to, 0, x);
        store.music = { ...store.music, queue: q }; // сразу показываем новый порядок, сервер подтвердит
        rt.send({ t: 'music:move', qid: it.qid, to });
      }
      render();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }

  const offs = [bus.on('music', render), bus.on('media', (m) => { if (m.kind === 'audio') render(); }), bus.on('media:gone', render), bus.on('media:reset', render)];
  render();
  el.destroy = () => { for (const off of offs) off(); };
  return el;
}
