// Комната на клиенте: подстройка под состояние сервера, чат, реакции, зрители.
import { h, clamp, fmtTime } from './util.js';
import { icon } from './icons.js';
import { rt, bus, store } from './api.js';
import { seg, avatar, range } from './ui.js';

export const REACTIONS = ['😂', '❤️', '👍', '😮', '😢', '🔥', '👏', '🎉'];

// ── Синхронизация ─────────────────────────────────────────────────────────
// Сервер хранит { playing, position, updatedAt, rate, waiting }. Часы сверены (rt.now()).
// Небольшое расхождение подтягиваем скоростью воспроизведения, большое — перемоткой.
export class RoomSession {
  constructor(roomId, hooks) {
    this.room = roomId;
    this.h = hooks;
    this.state = null;
    this.joined = false;
    this.viewers = [];
    this.drift = 0;
    this.localUntil = 0;
    this.lastSeek = 0;
    this.seekSeq = -1;
    this.notReadySince = 0;
    this.sent = { seq: -1, ready: null };
    this.offs = [];
    // Свёрнутую вкладку комната не ждёт: человек всё равно не смотрит, а когда вернётся — догонит.
    this.onVis = () => {
      rt.send({ t: 'room:status', away: document.hidden });
      if (!document.hidden) this.tick();
    };
  }

  start() {
    const on = (type, fn) => this.offs.push(bus.on(type, (m) => { if (m.room === undefined || m.room === this.room) fn(m); }));
    on('room:joined', (m) => {
      this.joined = true;
      this.wasReady = false;
      this.viewers = m.viewers;
      this.sent = { seq: -1, ready: null };
      if (document.hidden) rt.send({ t: 'room:status', away: true });
      this.h.onJoined?.(m);
      this.setState(m.state);
    });
    on('room:state', (m) => { if (this.joined) this.setState(m); });
    on('room:viewers', (m) => { this.viewers = m.viewers; this.h.onViewers?.(m.viewers); });
    on('room:event', (m) => this.h.onEvent?.(m));
    on('room:chat', (m) => this.h.onChat?.(m.msg));
    on('room:react', (m) => this.h.onReact?.(m));
    on('room:closed', (m) => this.h.onGone?.('closed', m));
    on('room:gone', (m) => this.h.onGone?.('gone', m));
    for (const t of ['voice:peers', 'voice:signal', 'voice:left', 'voice:state']) this.offs.push(bus.on(t, (m) => this.h.onVoice?.(m)));
    this.offs.push(bus.on('rt:hello', () => this.join())); // после обрыва связи заходим снова
    this.offs.push(bus.on('rt', (open) => { if (!open) { this.joined = false; this.h.onOffline?.(); } }));
    this.timer = setInterval(() => this.tick(), 200);
    document.addEventListener('visibilitychange', this.onVis);
    if (rt.open) this.join();
  }

  join() {
    this.joined = false;
    rt.send({ t: 'room:join', room: this.room });
  }

  stop() {
    clearInterval(this.timer);
    for (const off of this.offs) off();
    this.offs = [];
    document.removeEventListener('visibilitychange', this.onVis);
    if (this.joined) rt.send({ t: 'room:leave' });
    this.joined = false;
  }

  setState(m) {
    const prev = this.state;
    this.state = m;
    this.localUntil = 0;
    if (!prev || prev.mediaId !== m.mediaId) this.wasReady = false;
    this.h.onState?.(m, prev);
    this.tick();
  }

  target() {
    const s = this.state;
    let p = s.position;
    if (s.playing && !s.waiting) p += ((rt.now() - s.updatedAt) / 1000) * s.rate;
    return p;
  }

  // Действие пользователя: сразу применяем у себя и отправляем всем.
  control(action, value) {
    const el = this.h.getEl();
    if (!this.state || !this.joined) return;
    this.localUntil = performance.now() + 700;
    if (action === 'play') { rt.send({ t: 'room:control', action }); this.h.play(); }
    else if (action === 'pause') { rt.send({ t: 'room:control', action }); this.h.pause(); }
    else if (action === 'seek') {
      rt.send({ t: 'room:control', action, position: value });
      if (el) { try { el.currentTime = value; } catch {} }
    } else if (action === 'rate') rt.send({ t: 'room:control', action, rate: value });
  }

  tick() {
    const s = this.state;
    const el = this.h.getEl();
    if (!s || !el || !this.joined || !s.mediaId) return;
    if (!Number.isFinite(el.duration) || !el.duration || el.readyState < 1) return this.report(false, el, false);
    const switching = !!this.h.isSwitching?.();
    const now = performance.now();
    const want = s.playing && !s.waiting;
    const t = clamp(this.target(), 0, Math.max(0, el.duration - 0.05));
    const diff = t - el.currentTime;
    this.drift = diff;
    if (!switching && now >= this.localUntil) {
      const rate = (r) => { if (Math.abs(el.playbackRate - r) > 0.004) el.playbackRate = r; };
      const seek = (to) => {
        if (now - this.lastSeek < 2500 && this.seekSeq === s.seq) return; // не гоняемся за буферизацией
        this.lastSeek = now;
        this.seekSeq = s.seq;
        try { el.currentTime = to; } catch {}
      };
      if (want) {
        if (el.paused) this.h.play();
        if (!el.seeking) {
          if (Math.abs(diff) > 1.2) { seek(t + 0.06); rate(s.rate); } // большое расхождение — перемоткой
          else if (Math.abs(diff) > 0.045) rate(s.rate * (1 + clamp(diff * 0.6, -0.12, 0.12))); // небольшое — скоростью
          else rate(s.rate);
        }
      } else {
        if (!el.paused) this.h.pause();
        rate(s.rate);
        if (Math.abs(diff) > 0.04 && !el.seeking) seek(t);
      }
    }
    this.report(want, el, switching);
  }

  // Сообщаем серверу, готово ли видео: пока у кого-то грузится, комната ждёт.
  report(want, el, switching) {
    const s = this.state;
    const now = performance.now();
    const loaded = !!el.duration && !el.seeking;
    const real = loaded && (el.readyState >= 3 || (el.paused && el.readyState >= 2 && now - this.lastSeek > 1200));
    if (real) this.wasReady = true;
    // Смена качества не считается подвисанием; а вот первую загрузку «готовой» не называем — иначе новичок тормозил бы всех.
    const ready = real || (switching && this.wasReady);
    if (ready) {
      this.notReadySince = 0;
      if (this.sent.ready !== true || this.sent.seq !== s.seq) {
        this.sent = { ready: true, seq: s.seq };
        rt.send({ t: 'room:status', ready: true, seq: s.seq });
      }
    } else {
      if (!this.notReadySince) this.notReadySince = now;
      if (now - this.notReadySince > 450 && this.sent.ready !== false && (want || s.waiting)) {
        this.sent = { ready: false, seq: s.seq };
        rt.send({ t: 'room:status', ready: false, seq: s.seq });
      }
    }
  }
}

// Текст события для тоста. Настоящее время — чтобы не гадать род по имени.
export function eventText(e) {
  const n = e.user?.name || 'Кто-то';
  switch (e.type) {
    case 'play': return `${n} продолжает просмотр`;
    case 'pause': return `${n} ставит на паузу`;
    case 'seek': return `${n} перематывает на ${fmtTime(e.position)}`;
    case 'rate': return `${n} меняет скорость: ${String(e.rate).replace('.', ',')}×`;
    case 'media': return `${n} включает «${e.title}»`;
    case 'join': return `${n} заходит в комнату`;
    case 'leave': return `${n} выходит`;
    default: return '';
  }
}

export function reactionBar(onPick) {
  return h('div.reacts', REACTIONS.map((e) => h('button.react', { type: 'button', 'aria-label': `Реакция ${e}`, onclick: () => onPick(e) }, e)));
}

// ── Панель: чат и зрители (и дополнительные вкладки, например очередь) ────
export function roomPanel({ onSeek, extra = [], who = 'Зрители', voice = null }) {
  const chatList = h('div.chat-list');
  const chatEmpty = h('div.chat-empty', 'Здесь будет чат комнаты. Напиши первым — сообщение получит отметку момента.');
  chatList.append(chatEmpty);
  const input = h('input.input', { placeholder: 'Сообщение…', maxLength: 500, autocomplete: 'off', enterKeyHint: 'send' });
  const newPill = h('button.chat-new', { type: 'button', hidden: true, onclick: () => { toBottom(true); } }, 'Новые сообщения ↓');
  const form = h('form.chat-form', {
    onsubmit: (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      if (rt.send({ t: 'room:chat', text })) input.value = '';
    },
  }, input, h('button.btn.btn-primary.btn-icon', { type: 'submit', 'aria-label': 'Отправить' }, icon('send', 'ic-s')));
  const viewersEl = h('div.viewers');

  const panes = [
    ...extra.map((x) => ({ key: x.key, label: x.label, el: h('div.rpane', x.el) })),
    { key: 'chat', label: 'Чат', el: h('div.rpane', chatList, newPill, form) },
    { key: 'who', label: who, el: h('div.rpane', viewersEl) },
  ];
  let tab = panes[0].key;
  let unread = 0;
  const tabs = seg(panes.map((p) => ({ value: p.key, label: p.label })), tab, (v) => { tab = v; show(); }, { block: true });
  const body = h('div.rpanel-body', panes.map((p) => p.el));
  const show = () => {
    for (const p of panes) p.el.classList.toggle('on', p.key === tab);
    if (tab === 'chat') { unread = 0; tabs.label('chat', 'Чат'); toBottom(true); }
  };

  const nearBottom = () => chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 80;
  function toBottom(force) {
    if (force || nearBottom()) { chatList.scrollTop = chatList.scrollHeight; newPill.hidden = true; }
  }
  chatList.addEventListener('scroll', () => { if (nearBottom()) newPill.hidden = true; });

  let last = null;
  function addChat(msg, silent = false) {
    chatEmpty.remove();
    const stick = nearBottom();
    const same = last && last.user.id === msg.user.id && msg.ts - last.ts < 120000;
    last = msg;
    const at = msg.at != null ? h('button.msg-at.num', { type: 'button', title: 'Перейти к этому моменту', onclick: () => onSeek?.(msg.at) }, `на ${fmtTime(msg.at)}`) : null;
    chatList.append(h(`div.msg${same ? '.same' : ''}`, avatar(msg.user, 's'),
      h('div', h('div.msg-head', h('b.clip', msg.user.name), at), h('div.msg-text', msg.text, same && at ? [' ', at.cloneNode(true)] : null))));
    if (same && at) chatList.lastChild.querySelector('.msg-text .msg-at').onclick = () => onSeek?.(msg.at);
    if (msg.user.id === store.me.id || stick) toBottom(true);
    else if (!silent) newPill.hidden = false;
    if (!silent && tab !== 'chat' && msg.user.id !== store.me.id) { unread++; tabs.label('chat', `Чат · ${unread}`); }
  }
  function addSys(text) {
    chatEmpty.remove();
    last = null;
    const stick = nearBottom();
    chatList.append(h('div.sysmsg', text));
    if (stick) toBottom(true);
  }
  function setChat(list) {
    chatList.replaceChildren();
    last = null;
    if (!list.length) chatList.append(chatEmpty);
    for (const m of list) addChat(m, true);
    toBottom(true);
  }

  const STATUS = { ok: 'на связи', loading: 'загружает…', buffering: 'буферизация…', away: 'свернул вкладку' };
  let speaking = new Set();
  let viewers = [];
  function drawViewers() {
    // один человек с двух устройств — одна строка
    const byUser = new Map();
    for (const v of viewers) {
      const cur = byUser.get(v.id);
      if (!cur) byUser.set(v.id, { ...v, cids: [v.cid] });
      else { cur.cids.push(v.cid); if (v.voice) cur.voice = v.voice; if (v.status !== 'ok') cur.status = v.status; }
    }
    tabs.label('who', `${who} · ${byUser.size}`);
    viewersEl.replaceChildren(...[...byUser.values()].map((v) => {
      const sp = v.cids.some((c) => speaking.has(c));
      const a = avatar(v);
      if (sp) a.classList.add('speaking');
      const me = v.id === store.me.id;
      let ctl = null;
      if (v.voice) {
        const peer = voice && !me && voice.joined ? v.cids.find((c) => voice.peers.has(c)) : null;
        ctl = h('div.vctl', icon(v.voice.muted ? 'micOff' : 'mic', 'ic-s'),
          peer ? range(Math.round(voice.volumeOf(v.id) * 100), { oninput: (x) => voice.setVolume(v.id, x / 100) }) : null);
      }
      return h('div.viewer', a,
        h('div', h('b.clip', v.name, me ? ' (ты)' : ''), h('div.st', [v.role === 'owner' ? 'владелец' : null, sp ? 'говорит' : STATUS[v.status] || ''].filter(Boolean).join(' · '))),
        ctl);
    }));
  }

  const el = h('div.rpanel', { style: { display: 'contents' } }, tabs, body);
  show();
  return {
    el, addChat, addSys, setChat,
    setViewers(list) { viewers = list; drawViewers(); },
    setSpeaking(set) { speaking = set; drawViewers(); },
    redraw: drawViewers,
    setTab(v) { tab = v; tabs.set(v); show(); },
    focusChat() { input.focus(); },
  };
}
