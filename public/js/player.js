// Свой видеоплеер. Сам выбирает версию, которую умеет играть браузер, и качество под экран и сеть.
import { h, clamp, fmtTime, fmtBytes, isIOS, isMobile, isTouch, ls } from './util.js';
import { icon } from './icons.js';
import { range } from './ui.js';
import { post } from './api.js';

const CODEC = { h264: 'H.264', vp9: 'VP9', av1: 'AV1', hevc: 'HEVC' };
const STD = [360, 480, 720, 1080, 1440, 2160, 4320];
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// Кодеки, которые на этом устройстве не заработали (ошибка декодера или кадры не рисуются).
// Ошибку декодера помним сутки, «нет кадров» — только до перезагрузки страницы: вдруг это была случайность.
const badStore = ls.get('badcodecs', {});
const bad = new Set(Object.entries(badStore && typeof badStore === 'object' && !Array.isArray(badStore) ? badStore : {}).filter(([, t]) => Date.now() - t < 24 * 3600e3).map(([c]) => c));
const verified = new Set();
function markBad(codec, persist) {
  bad.add(codec);
  if (persist) { const st = ls.get('badcodecs', {}); const o = st && typeof st === 'object' && !Array.isArray(st) ? st : {}; o[codec] = Date.now(); ls.set('badcodecs', o); }
  canCache.clear();
}
const probe = document.createElement('video');
const canCache = new Map();

export function canPlay(v) {
  if (!v) return false;
  if (v.codec === 'h264') return true;
  if (bad.has(v.codec)) return false;
  if (isIOS && v.codec === 'vp9') return false; // iPhone и iPad VP9 не играют, Safari на Mac — играет
  const key = v.codecStr || v.codec;
  if (!canCache.has(key)) {
    const t = v.codecStr ? probe.canPlayType(`video/mp4; codecs="${v.codecStr}"`) : '';
    canCache.set(key, t === 'probably' || t === 'maybe');
  }
  return canCache.get(key);
}

function screenQ() {
  const dpr = window.devicePixelRatio || 1;
  const w = screen.width * dpr, hh = screen.height * dpr;
  const box = Math.min((Math.max(w, hh) * 9) / 16, Math.min(w, hh));
  return STD.find((s) => s >= box * 0.9) || 4320;
}

export class Player {
  constructor({ media, onAction = null, onBack = null, room = false }) {
    this.media = media;
    this.onAction = onAction;
    this.onBack = onBack;
    this.room = room;
    this.roomUi = null; // { playing } — в комнате кнопка показывает общее состояние
    this.onMeta = null;
    this.onUserGesture = null;

    this.pref = ls.get('q', 'auto');
    const forced = new URLSearchParams(location.search);
    if (forced.has('autotest') && forced.get('q')) this.pref = Number(forced.get('q')); // только для автопроверки
    this.autoDrop = 0;
    this.stalls = [];
    this.lastUpgrade = 0;
    this.cur = null;
    this.switching = false;
    this.switchTimer = null;
    this.resumeAt = 0;
    this.resumePlay = false;
    this.wantPlay = false;
    this.selfPause = false;
    this.forcedMute = false;
    this.volume = clamp(Number(ls.get('vol', 1)) || 0, 0, 1);
    this.muted = !!ls.get('muted', false);
    this.duck = 1;
    this.duckNow = 1;
    this.zoom = 100;
    this.subPref = ls.get('sub', 'off');
    this.statsOn = false;
    this.dragging = false;
    this.lastSeekAt = 0;
    this.netRetries = 0;
    this.destroyed = false;
    this.timers = new Set();
    this.offs = [];

    this.build();
    this.bind();
    this.applyVolume();
    this.setTracks();
    this.loadBest({ initial: true });
    this.poke();
    this.autotest();
  }

  // ── Разметка ────────────────────────────────────────────────────────────
  build() {
    const b = (name, title, fn, cls = '') => h(`button.pbtn${cls}`, { type: 'button', title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); fn(e); } }, icon(name));
    this.video = h('video', { playsInline: true, preload: 'auto' });
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');
    this.video.disableRemotePlayback = true;
    this.canvas = h('canvas', { hidden: true });
    this.poster = h('div.player-poster');
    this.subs = h('span');
    this.fx = h('div.player-fx');
    this.flashBox = h('div.player-flash');
    this.bannerSlot = h('div.player-banner-slot');
    this.waitSlot = h('div.player-wait-slot');
    this.big = h('button.player-big', { type: 'button', 'aria-label': 'Смотреть', onclick: (e) => { e.stopPropagation(); this.gesture(); this.togglePlay(); } }, icon('play'));
    this.tapL = h('div.player-tap.l', '−10 с');
    this.tapR = h('div.player-tap.r', '+10 с');
    this.unmuteBtn = h('button.player-unmute', { type: 'button', hidden: true, onclick: (e) => { e.stopPropagation(); this.unmute(); } }, icon('vol', 'ic-s'), 'Включить звук');

    this.titleEl = h('div.ttl.clip.grow', this.media?.title || '');
    this.backBtn = h('button.pbtn.pback', { type: 'button', title: 'Назад', onclick: (e) => { e.stopPropagation(); this.onBack?.(); } }, icon('back'));
    this.top = h('div.player-top', this.backBtn, this.titleEl);

    this.buf = h('div.pseek-buf');
    this.fill = h('div.pseek-fill');
    this.thumb = h('div.pseek-thumb');
    this.tip = h('div.pseek-tip', '0:00');
    this.seek = h('div.pseek', { role: 'slider', 'aria-label': 'Перемотка', tabIndex: -1 }, this.buf, this.fill, this.thumb, this.tip);
    this.playBtn = b('play', 'Смотреть / пауза (пробел)', () => { this.gesture(); this.togglePlay(); });
    this.timeEl = h('div.ptime', h('b', '0:00'), ' / ', h('span', '0:00'));
    this.badge = h('span.pbadge');
    this.muteBtn = b('vol', 'Звук (M)', () => this.toggleMute());
    this.volRange = range(Math.round(this.volume * 100), { oninput: (v) => this.setVolume(v / 100) });
    this.volRange.addEventListener('click', (e) => e.stopPropagation());
    this.gearBtn = b('gear', 'Настройки', () => this.toggleMenu(), '.gear');
    this.pipBtn = b('pip', 'Картинка в картинке', () => this.togglePip(), '.hide-s');
    this.fsBtn = b('fs', 'Полный экран (F)', () => this.toggleFullscreen());
    this.bar = h('div.player-bar', this.seek,
      h('div.pbar-row', this.playBtn, this.timeEl, this.badge, h('div.grow'),
        h('div.pvol', this.muteBtn, h('div.pvol-slide', this.volRange)), this.gearBtn, this.pipBtn, this.fsBtn));

    this.menuMain = h('div.pmenu-page');
    this.menuSub = h('div.pmenu-page');
    this.menuPages = h('div.pmenu-pages', this.menuMain, this.menuSub);
    this.menu = h('div.player-menu', { onclick: (e) => e.stopPropagation() }, this.menuPages);
    this.statsEl = h('div.player-stats', { hidden: true });

    this.el = h(`div.player${isTouch ? '.touch' : ''}`, { tabIndex: 0 },
      h('div.player-stage', this.video, this.canvas, this.poster),
      h('div.player-subs', this.subs), this.fx,
      h('div.player-center', this.tapL, this.tapR, h('div.player-load'), this.big),
      this.flashBox, this.bannerSlot, this.waitSlot, this.unmuteBtn, this.statsEl, this.top, this.bar, this.menu);
    if (this.media?.poster) this.poster.style.backgroundImage = `url("${this.media.poster}")`;

    const pipOk = document.pictureInPictureEnabled || typeof this.video.webkitSupportsPresentationMode === 'function';
    if (!pipOk) this.pipBtn.hidden = true;
    // На iPhone громкость программно не меняется — оставляем только кнопку звука.
    try { this.video.volume = 0.5; if (this.video.volume !== 0.5) this.el.classList.add('novol'); } catch { this.el.classList.add('novol'); }
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.offs.push(() => target.removeEventListener(type, fn, opts));
  }
  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.destroyed) fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  bind() {
    const v = this.video;
    this.on(v, 'loadedmetadata', () => this.onLoadedMeta());
    this.on(v, 'canplay', () => this.onCanPlay());
    this.on(v, 'play', () => { this.sync(); this.maybeExternal('play'); });
    this.on(v, 'pause', () => { this.sync(); this.maybeExternal('pause'); });
    this.on(v, 'playing', () => { this.el.classList.remove('buffering'); this.poster.classList.add('hide'); this.checkFramesSoon(); });
    this.on(v, 'waiting', () => this.onWaiting());
    this.on(v, 'seeking', () => { this.lastSeekAt = performance.now(); });
    this.on(v, 'seeked', () => { this.paintTime(); if (v.currentTime > 0.3 && v.readyState >= 2 && !isIOS) this.poster.classList.add('hide'); });
    this.on(v, 'timeupdate', () => this.paintTime());
    this.on(v, 'progress', () => this.paintBuffer());
    this.on(v, 'durationchange', () => this.paintTime());
    this.on(v, 'ratechange', () => { if (this.menuOpen) this.drawMenu(); });
    this.on(v, 'ended', () => { this.sync(); if (!this.room) this.poke(); });
    this.on(v, 'error', () => this.onError());
    this.on(v, 'webkitbeginfullscreen', () => { this.nativeFs = true; this.showNativeSubs(true); });
    this.on(v, 'webkitendfullscreen', () => { this.nativeFs = false; this.showNativeSubs(false); });
    this.on(v, 'enterpictureinpicture', () => this.pipBtn.classList.add('on'));
    this.on(v, 'leavepictureinpicture', () => this.pipBtn.classList.remove('on'));
    const fsChange = () => {
      const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      this.fsBtn.replaceChildren(icon(on ? 'fsExit' : 'fs'));
      this.el.classList.toggle('is-fs', on);
      if (on && isMobile) screen.orientation?.lock?.('landscape').catch(() => {});
      if (!on) { try { screen.orientation?.unlock?.(); } catch {} }
    };
    this.on(document, 'fullscreenchange', fsChange);
    this.on(document, 'webkitfullscreenchange', fsChange);

    // Указатель: мышь — клик/двойной клик, палец — тап/двойной тап ±10 с.
    this.on(this.el, 'pointermove', (e) => { if (e.pointerType !== 'touch') this.poke(); });
    this.on(this.el, 'pointerleave', (e) => { if (e.pointerType !== 'touch' && this.shownPlaying() && !this.menuOpen) this.setIdle(true, 600); });
    let lastTap = 0, lastSide = 0, tapTimer = null, clickTimer = null;
    this.on(this.el, 'click', (e) => {
      if (e.target.closest('.player-bar, .player-menu, .player-top, .player-banner, button, input')) return;
      this.gesture();
      if (this.menuOpen) { this.toggleMenu(false); return; }
      const touch = (e.pointerType || (isTouch ? 'touch' : 'mouse')) === 'touch';
      if (touch) {
        const r = this.el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        const side = x < 0.36 ? -1 : x > 0.64 ? 1 : 0;
        const now = performance.now();
        if (side && now - lastTap < 320 && side === lastSide) {
          clearTimeout(tapTimer);
          lastTap = now; // серия тапов продолжает перематывать
          this.nudge(side * 10, true);
          return;
        }
        lastTap = now;
        lastSide = side;
        clearTimeout(tapTimer);
        const wasIdle = this.el.classList.contains('idle');
        tapTimer = setTimeout(() => { if (wasIdle || !this.shownPlaying()) this.poke(); else this.setIdle(true); }, side ? 300 : 0);
        return;
      }
      if (clickTimer) { // двойной клик — полный экран
        clearTimeout(clickTimer);
        clickTimer = null;
        this.toggleFullscreen();
        return;
      }
      clickTimer = setTimeout(() => { clickTimer = null; this.togglePlay(); }, 210);
    });

    // Полоса перемотки
    const frac = (e) => { const r = this.seek.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
    const tipAt = (f) => {
      const d = this.duration();
      this.tip.textContent = fmtTime(f * d);
      const w = this.seek.clientWidth;
      this.tip.style.left = `${clamp(f * w, 22, w - 22)}px`;
    };
    this.on(this.seek, 'pointermove', (e) => {
      const f = frac(e);
      tipAt(f);
      if (this.dragging) this.paintSeek(f);
    });
    this.on(this.seek, 'pointerdown', (e) => {
      if (!this.duration()) return;
      e.stopPropagation();
      this.gesture();
      this.dragging = true;
      this.seek.classList.add('drag');
      try { this.seek.setPointerCapture(e.pointerId); } catch {}
      const f = frac(e);
      tipAt(f);
      this.paintSeek(f);
    });
    const endDrag = (e, commit) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.seek.classList.remove('drag');
      if (commit) this.act('seek', frac(e) * this.duration());
      this.poke();
    };
    this.on(this.seek, 'pointerup', (e) => endDrag(e, true));
    this.on(this.seek, 'pointercancel', (e) => endDrag(e, false));
    this.on(this.seek, 'click', (e) => e.stopPropagation());

    // Клавиши: пробел, ←/→, F, M (по физическим клавишам — раскладка не важна)
    this.on(document, 'keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && t.type !== 'range') return;
      if (document.querySelector('.sheet-wrap')) return;
      switch (e.code) {
        case 'Space': case 'KeyK': e.preventDefault(); this.gesture(); this.togglePlay(); break;
        case 'ArrowLeft': e.preventDefault(); this.nudge(e.shiftKey ? -30 : -5); break;
        case 'ArrowRight': e.preventDefault(); this.nudge(e.shiftKey ? 30 : 5); break;
        case 'ArrowUp': e.preventDefault(); this.setVolume(this.volume + 0.05); this.flash(`Громкость ${Math.round(this.volume * 100)}%`, 900, 'vol'); break;
        case 'ArrowDown': e.preventDefault(); this.setVolume(this.volume - 0.05); this.flash(`Громкость ${Math.round(this.volume * 100)}%`, 900, 'vol'); break;
        case 'KeyF': e.preventDefault(); this.toggleFullscreen(); break;
        case 'KeyM': e.preventDefault(); this.toggleMute(); break;
        case 'Escape': if (this.menuOpen) this.toggleMenu(false); else if (this.el.classList.contains('pseudo-fs')) this.el.classList.remove('pseudo-fs'); break;
        default: return;
      }
      this.poke();
    });

    this.on(document, 'visibilitychange', () => { if (!document.hidden) this.paintTime(); });
    this.statsTimer = setInterval(() => { if (this.statsOn) this.paintStats(); }, 500);

    if ('mediaSession' in navigator) {
      try {
        const ms = navigator.mediaSession;
        ms.setActionHandler('play', () => this.act('play'));
        ms.setActionHandler('pause', () => this.act('pause'));
        ms.setActionHandler('seekbackward', () => this.nudge(-10));
        ms.setActionHandler('seekforward', () => this.nudge(10));
        ms.setActionHandler('seekto', (d) => { if (d.seekTime != null) this.act('seek', d.seekTime); });
      } catch {}
    }
    this.setSessionMeta();
  }

  setSessionMeta() {
    if (!('mediaSession' in navigator) || !window.MediaMetadata || !this.media) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.media.title, artist: 'Ложа',
        artwork: this.media.poster ? [{ src: this.media.poster, sizes: '960x540', type: 'image/jpeg' }] : [],
      });
    } catch {}
  }

  // ── Версии и качество ───────────────────────────────────────────────────
  variants() { return (this.media?.variants || []).filter((v) => v.status === 'ready'); }
  playable() {
    return this.variants().filter(canPlay).sort((a, b) => b.q - a.q || (a.kind === 'source' ? -1 : 1));
  }
  // «Авто»: на телефоне не выше 720p, на компьютере — под экран; после подвисаний — на ступень ниже.
  autoTarget() {
    const list = this.playable();
    if (!list.length) return null;
    const cap = isMobile ? 720 : screenQ();
    let pool = list.filter((v) => v.q <= cap * 1.08);
    if (!pool.length) pool = [list[list.length - 1]];
    return pool[Math.min(this.autoDrop, pool.length - 1)];
  }
  choose() {
    if (this.pref !== 'auto') {
      const want = this.playable().find((v) => v.q === this.pref);
      if (want) return want;
    }
    return this.autoTarget();
  }

  loadBest({ initial = false } = {}) {
    const v = this.choose();
    if (!v) { this.cur = null; this.showPreparing(); return; }
    if (this.cur && this.cur.id === v.id) return;
    // Исходник есть, но браузер его не тянет — коротко сообщаем, что включили совместимую версию.
    const src = this.variants().find((x) => x.kind === 'source');
    if (initial && src && !canPlay(src) && v.kind !== 'source') {
      this.flash(`Этот браузер не играет ${CODEC[src.codec] || src.codec} — включил совместимую версию ${v.label}`, 5000);
    }
    this.load(v, { keepTime: !initial });
  }

  load(v, { keepTime = false } = {}) {
    const video = this.video;
    const t = keepTime ? video.currentTime : 0;
    this.resumePlay = keepTime ? (!video.paused || this.wantPlay) : this.wantPlay;
    this.resumeAt = t;
    this.switching = true;
    clearTimeout(this.switchTimer);
    this.switchTimer = this.later(() => this.endSwitch(), 9000);
    this.setBanner(null);
    if (keepTime && video.videoWidth && video.readyState >= 2) this.freeze();
    this.cur = v;
    this.metaReady = false;
    video.src = v.url;
    video.load();
    this.applyVolume();
    this.applyZoom();
    this.badge.textContent = v.label;
    if (this.menuOpen) this.drawMenu();
  }

  freeze() {
    try {
      const c = this.canvas, v = this.video;
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.hidden = false;
    } catch {}
  }
  endSwitch() {
    clearTimeout(this.switchTimer);
    this.switching = false;
    this.canvas.hidden = true;
  }

  onLoadedMeta() {
    this.metaReady = true;
    this.netRetries = 0;
    this.paintTime();
    this.applyTrack();
    if (!this.room && this.resumeAt > 0.4) {
      try { this.video.currentTime = Math.min(this.resumeAt, Math.max(0, this.video.duration - 0.3)); } catch {}
    }
    this.onMeta?.();
  }

  onCanPlay() {
    if (!this.switching) return;
    this.endSwitch();
    if (!this.room && this.resumePlay) this.play();
    this.onMeta?.();
  }

  setMedia(m) {
    const same = this.media && m.id === this.media.id;
    this.media = m;
    if (!same) {
      this.cur = null;
      this.autoDrop = 0;
      this.stalls = [];
      this.zoom = 100;
      this.titleEl.textContent = m.title;
      this.poster.classList.remove('hide');
      this.poster.style.backgroundImage = m.poster ? `url("${m.poster}")` : '';
      this.subs.textContent = '';
      this.setTracks();
      this.setSessionMeta();
      this.wantPlay = false;
      this.loadBest({ initial: true });
      return;
    }
    this.titleEl.textContent = m.title;
    if (this.menuOpen) this.drawMenu();
    if (!this.cur) return this.loadBest({ initial: true }); // ждали совместимую версию — включаем сами
    if (!this.variants().some((v) => v.id === this.cur.id)) return this.loadBest({});
    // Появилась версия лучше той, что идёт вынужденно, — переходим на неё (не чаще раза в 20 с).
    const t = this.choose();
    if (t && t.id !== this.cur.id && t.q > this.cur.q && performance.now() - this.lastUpgrade > 20000 && this.pref === 'auto') {
      this.lastUpgrade = performance.now();
      this.load(t, { keepTime: true });
    }
  }

  setQuality(pref) {
    this.pref = pref;
    ls.set('q', pref);
    this.autoDrop = 0;
    this.stalls = [];
    const v = this.choose();
    if (v && (!this.cur || v.id !== this.cur.id)) this.load(v, { keepTime: true });
    this.drawMenu();
  }

  showPreparing() {
    const pend = (this.media?.variants || []).filter((v) => v.codec === 'h264' && (v.status === 'processing' || v.status === 'queued'));
    if (!pend.length) {
      this.setBanner(h('div.player-banner', icon('warn'), h('div', this.media?.status === 'ready' ? 'Этот браузер не может воспроизвести видео: совместимой версии нет.' : 'Видео ещё обрабатывается — немного подожди.')));
      return;
    }
    const p = Math.max(0, ...pend.map((v) => (v.status === 'processing' ? v.progress : 0)));
    const text = `Готовлю совместимую версию… ${Math.floor(p)}% — включится сама`;
    if (this.prepBanner && this.bannerSlot.contains(this.prepBanner)) {
      this.prepBanner._t.textContent = text;
      this.prepBanner._b.style.width = `${p}%`;
      return;
    }
    const t = h('div', text), bar = h('i', { style: { width: `${p}%` } });
    this.prepBanner = h('div.player-banner', t, h('div.meter', bar));
    Object.assign(this.prepBanner, { _t: t, _b: bar });
    this.setBanner(this.prepBanner);
  }

  // Кадры реально рисуются? canPlayType иногда обещает лишнего.
  checkFramesSoon() {
    const v = this.cur;
    if (!v || v.codec === 'h264' || verified.has(v.codec)) return;
    const t0 = this.video.currentTime;
    // Надёжный признак: браузер сам сообщил о показанном кадре.
    try { this.video.requestVideoFrameCallback?.(() => verified.add(v.codec)); } catch {}
    this.later(() => {
      if (this.cur !== v || this.video.paused || this.switching || verified.has(v.codec)) return;
      if (document.hidden || this.video.currentTime - t0 < 0.8) return this.checkFramesSoon(); // в свёрнутой вкладке кадры не рисуются — не судим
      const q = this.video.getVideoPlaybackQuality?.();
      const frames = q ? q.totalVideoFrames : (this.video.webkitDecodedFrameCount ?? 1);
      if (!this.video.videoWidth || frames === 0) this.codecFailed(false);
      else verified.add(v.codec);
    }, 2600);
  }

  codecFailed(persist = true) {
    const from = this.cur;
    if (!from) return;
    markBad(from.codec, persist);
    const next = this.choose();
    if (next) {
      this.load(next, { keepTime: true });
      this.flash(`Этот браузер не играет ${CODEC[from.codec] || from.codec} — включил совместимую версию ${next.label}`, 5000);
    } else {
      this.cur = null;
      this.video.removeAttribute('src');
      this.video.load();
      this.endSwitch();
      this.showPreparing();
    }
  }

  onError() {
    const err = this.video.error;
    if (!err || !this.cur || this.destroyed) return;
    if (this.cur.codec !== 'h264' && err.code >= 3) return this.codecFailed();
    if (this.netRetries < 3) { // сеть моргнула — пробуем продолжить с того же места
      this.netRetries++;
      const v = this.cur, t = this.video.currentTime;
      this.later(() => { if (this.cur === v) { this.load(v, { keepTime: false }); this.resumeAt = t; this.resumePlay = this.wantPlay; } }, 900 * this.netRetries);
      return;
    }
    const lower = this.playable().filter((v) => v.q < this.cur.q)[0];
    if (lower && err.code >= 3) { this.load(lower, { keepTime: true }); return; }
    this.endSwitch();
    this.setBanner(h('div.player-banner', icon('warn'), h('div', 'Не удалось воспроизвести видео. Проверь соединение.'),
      h('button.btn.btn-s', { type: 'button', onclick: () => { this.netRetries = 0; this.setBanner(null); const v = this.cur; this.cur = null; if (v) this.load(v, {}); } }, 'Повторить')));
  }

  onWaiting() {
    if (this.wantPlay || !this.video.paused) this.el.classList.add('buffering');
    if (this.switching || this.video.seeking || performance.now() - this.lastSeekAt < 2500 || !this.metaReady) return;
    // Два подвисания за минуту на «Авто» — опускаемся на ступень ниже.
    const now = performance.now();
    this.stalls = this.stalls.filter((t) => now - t < 60000);
    this.stalls.push(now);
    if (this.pref === 'auto' && this.stalls.length >= 2) {
      const cur = this.cur;
      this.autoDrop++;
      const next = this.autoTarget();
      this.stalls = [];
      if (next && cur && next.id !== cur.id && next.q < cur.q) {
        this.load(next, { keepTime: true });
        this.flash(`Сеть не успевает — переключил на ${next.label}`, 3500);
      } else this.autoDrop--;
    }
  }

  // ── Воспроизведение ─────────────────────────────────────────────────────
  duration() { return Number.isFinite(this.video.duration) ? this.video.duration : (this.media?.duration || 0); }
  shownPlaying() { return this.roomUi ? this.roomUi.playing : !this.video.paused; }

  // Учитываем запрет автозапуска: если со звуком нельзя — запускаем без звука и показываем кнопку.
  async play() {
    this.wantPlay = true;
    if (!this.cur) return;
    try {
      await this.video.play();
      this.el.classList.remove('blocked');
    } catch (e) {
      if (e.name !== 'NotAllowedError') return;
      if (!this.video.muted) {
        this.forcedMute = true;
        this.applyVolume();
        try {
          await this.video.play();
          this.unmuteBtn.hidden = false;
          this.el.classList.add('has-unmute');
          return;
        } catch {}
      }
      this.wantPlay = false;
      this.sync();
    }
  }
  pause() {
    this.wantPlay = false;
    if (!this.video.paused) { this.selfPause = true; this.video.pause(); }
  }
  unmute() {
    this.forcedMute = false;
    this.muted = false;
    ls.set('muted', false);
    this.unmuteBtn.hidden = true;
    this.el.classList.remove('has-unmute');
    this.applyVolume();
  }
  gesture() {
    if (this.forcedMute) this.unmute();
    this.onUserGesture?.();
  }

  // Действие пользователя: в комнате уходит на сервер, в одиночном просмотре выполняется сразу.
  act(type, value) {
    if (this.onAction) return this.onAction(type, value);
    const v = this.video;
    if (type === 'play') this.play();
    else if (type === 'pause') this.pause();
    else if (type === 'seek') { try { v.currentTime = clamp(value, 0, Math.max(0, this.duration() - 0.2)); } catch {} this.paintTime(); }
    else if (type === 'rate') { v.playbackRate = value; this.baseRate = value; }
  }
  togglePlay() {
    if (!this.cur) return;
    if (this.video.ended && !this.room) { this.act('seek', 0); this.act('play'); return; }
    this.act(this.shownPlaying() ? 'pause' : 'play');
    this.poke();
  }
  nudge(delta, show = false) {
    const t = clamp(this.video.currentTime + delta, 0, Math.max(0, this.duration() - 0.3));
    this.act('seek', t);
    if (show) {
      const el = delta < 0 ? this.tapL : this.tapR;
      el.classList.remove('go');
      void el.offsetWidth;
      el.classList.add('go');
    } else this.flash(`${delta > 0 ? '+' : '−'}${Math.abs(delta)} с`, 700, 'nudge');
  }
  // Пауза не от наших кнопок (нативный полный экран на iPhone, окно «картинка в картинке») — тоже действие пользователя.
  maybeExternal(type) {
    if (type === 'pause' && this.selfPause) { this.selfPause = false; return; }
    if (!this.onAction || this.switching || this.video.ended || document.hidden) return;
    const external = this.nativeFs || document.pictureInPictureElement === this.video || this.video.webkitPresentationMode === 'picture-in-picture';
    if (!external) return;
    if (type === 'pause' && this.roomUi?.playing) this.onAction('pause');
    if (type === 'play' && this.roomUi && !this.roomUi.playing) this.onAction('play');
  }

  sync() {
    const playing = this.shownPlaying();
    this.el.classList.toggle('playing', playing);
    this.playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
    this.big.replaceChildren(icon(playing ? 'pause' : 'play'));
    if (!playing) { this.el.classList.remove('buffering'); this.setIdle(false); } else this.poke();
  }
  setRoomUi(ui) {
    this.roomUi = ui;
    this.sync();
  }

  // ── Громкость ───────────────────────────────────────────────────────────
  applyVolume() {
    const v = this.video;
    v.muted = this.muted || this.forcedMute;
    try { v.volume = clamp(this.volume * this.duckNow, 0, 1); } catch {}
    const silent = v.muted || this.volume === 0;
    this.muteBtn.replaceChildren(icon(silent ? 'mute' : this.volume < 0.5 ? 'volLow' : 'vol'));
    this.volRange.set(Math.round((this.muted ? 0 : this.volume) * 100));
  }
  setVolume(x) {
    this.volume = clamp(x, 0, 1);
    this.muted = this.volume === 0;
    if (this.volume > 0 && this.forcedMute) this.unmute();
    ls.set('vol', this.volume);
    ls.set('muted', this.muted);
    this.applyVolume();
  }
  toggleMute() {
    if (this.forcedMute) return this.unmute();
    this.muted = !this.muted;
    if (!this.muted && this.volume === 0) this.volume = 0.6;
    ls.set('muted', this.muted);
    this.applyVolume();
    this.flash(this.muted ? 'Звук выключен' : 'Звук включён', 900, 'vol');
  }
  // Пока кто-то говорит в голосовом чате, фильм немного приглушается.
  setDuck(target) {
    this.duck = target;
    if (this.duckTimer) return;
    this.duckTimer = setInterval(() => {
      const d = this.duck - this.duckNow;
      if (Math.abs(d) < 0.03) { this.duckNow = this.duck; clearInterval(this.duckTimer); this.duckTimer = null; } else this.duckNow += d * 0.3;
      try { this.video.volume = clamp(this.volume * this.duckNow, 0, 1); } catch {}
    }, 50);
  }

  // ── Отрисовка ───────────────────────────────────────────────────────────
  paintTime() {
    const d = this.duration(), t = this.video.currentTime || 0;
    this.timeEl.firstChild.textContent = fmtTime(t);
    this.timeEl.lastChild.textContent = fmtTime(d);
    if (!this.dragging) this.paintSeek(d ? t / d : 0);
    this.paintBuffer();
  }
  paintSeek(f) {
    this.fill.style.width = `${f * 100}%`;
    this.thumb.style.left = `${f * 100}%`;
  }
  bufferedEnd() {
    const v = this.video, t = v.currentTime;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 0.3 && v.buffered.end(i) >= t) return v.buffered.end(i);
    return t;
  }
  paintBuffer() {
    const d = this.duration();
    this.buf.style.width = d ? `${(this.bufferedEnd() / d) * 100}%` : '0';
  }

  poke() {
    this.setIdle(false);
    clearTimeout(this.idleTimer);
    if (this.shownPlaying()) this.idleTimer = setTimeout(() => this.setIdle(true), 2800);
  }
  setIdle(on, delay = 0) {
    clearTimeout(this.idleTimer);
    if (on && (this.menuOpen || this.dragging || !this.shownPlaying())) return;
    if (on && delay) { this.idleTimer = setTimeout(() => this.setIdle(true), delay); return; }
    this.el.classList.toggle('idle', on); // контролы плавно прячутся, когда мышь не двигается
  }

  flash(text, ms = 2600, key = '') {
    if (key) for (const old of this.flashBox.querySelectorAll(`[data-key="${key}"]`)) old.remove();
    while (this.flashBox.children.length >= 3) this.flashBox.firstElementChild.remove();
    const el = h('div.pflash', { dataset: { key } }, text);
    this.flashBox.append(el);
    void el.offsetWidth;
    el.classList.add('in');
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 240); }, ms);
  }
  setBanner(node) {
    this.bannerSlot.replaceChildren(...(node ? [node] : []));
    this.el.classList.toggle('blocked', !!node);
  }
  setWait(text) {
    if (!text) { this.waitSlot.replaceChildren(); return; }
    if (this.waitSlot.firstChild) { this.waitSlot.firstChild.lastChild.textContent = text; return; }
    this.waitSlot.replaceChildren(h('div.player-wait', h('span.spin'), h('span', text)));
  }

  // Реакции всплывают поверх видео.
  react(emoji, name = '') {
    const el = h('div.fx-emoji', { style: { left: `${8 + Math.random() * 78}%`, '--dx': `${(Math.random() - 0.5) * 120}px`, '--rot': `${(Math.random() - 0.5) * 40}deg` } }, emoji, name ? h('small', name) : null);
    this.fx.append(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ── Субтитры (рисуем сами, чтобы масштаб и полный экран их не ломали) ──
  setTracks() {
    for (const t of [...this.video.querySelectorAll('track')]) t.remove();
    for (const s of this.media?.subtitles || []) {
      const tr = h('track', { kind: 'subtitles', label: s.label, srclang: s.lang || 'und', src: s.url });
      tr.dataset.id = s.id;
      tr.addEventListener('cuechange', () => this.paintCue(tr.track));
      this.video.append(tr);
    }
    this.applyTrack();
  }
  applyTrack() {
    const subs = this.media?.subtitles || [];
    const want = this.subPref === 'off' ? null : (subs.find((s) => String(s.id) === String(this.subPref)) || subs.find((s) => s.lang === this.subPref) || null);
    this.activeSub = want;
    const tracks = this.video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      const el = this.video.querySelectorAll('track')[i];
      const on = !!want && el && el.dataset.id === String(want.id);
      tracks[i].mode = on ? (this.nativeFs ? 'showing' : 'hidden') : 'disabled';
    }
    if (!want) this.subs.textContent = '';
  }
  paintCue(track) {
    if (track.mode !== 'hidden') { if (track.mode === 'disabled') return; }
    const cues = track.activeCues;
    const lines = [];
    for (let i = 0; cues && i < cues.length; i++) lines.push(String(cues[i].text || '').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim());
    this.subs.textContent = lines.filter(Boolean).join('\n');
  }
  showNativeSubs(on) {
    const tracks = this.video.textTracks;
    for (let i = 0; i < tracks.length; i++) if (tracks[i].mode !== 'disabled') tracks[i].mode = on ? 'showing' : 'hidden';
    if (on) this.subs.textContent = '';
  }
  setSub(pref) {
    this.subPref = pref;
    ls.set('sub', pref === 'off' ? 'off' : (this.media.subtitles.find((s) => String(s.id) === String(pref))?.lang || pref));
    this.applyTrack();
    this.drawMenu();
  }

  // ── Масштаб, полный экран, PiP ──────────────────────────────────────────
  applyZoom() {
    const t = this.zoom === 100 ? '' : `scale(${this.zoom / 100})`;
    this.video.style.transform = t;
    this.canvas.style.transform = t;
  }
  setZoom(z) {
    this.zoom = clamp(Math.round(z / 5) * 5, 50, 200);
    this.applyZoom();
    this.drawMenu();
  }
  toggleFullscreen() {
    const el = this.el, v = this.video;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    if (el.classList.contains('pseudo-fs')) { el.classList.remove('pseudo-fs'); this.fsBtn.replaceChildren(icon('fs')); return; }
    const pseudo = () => { el.classList.add('pseudo-fs'); this.fsBtn.replaceChildren(icon('fsExit')); };
    if (el.requestFullscreen) el.requestFullscreen().catch(() => (v.webkitEnterFullscreen ? v.webkitEnterFullscreen() : pseudo()));
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else if (v.webkitEnterFullscreen) { // запасной вариант для iPhone: системный плеер
      try { v.webkitEnterFullscreen(); } catch { pseudo(); }
    } else pseudo();
  }
  async togglePip() {
    const v = this.video;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v.requestPictureInPicture) await v.requestPictureInPicture();
      else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    } catch { this.flash('Картинка в картинке сейчас недоступна', 1800); }
  }

  // ── Меню настроек ───────────────────────────────────────────────────────
  toggleMenu(force) {
    this.menuOpen = force ?? !this.menuOpen;
    this.el.classList.toggle('menu-open', this.menuOpen);
    if (this.menuOpen) { this.menuPage = null; this.drawMenu(); this.setIdle(false); } else this.poke();
  }
  drawMenu() {
    if (!this.menuOpen) return;
    const item = (ic, label, val, fn, opts = {}) => h(`button.pmenu-item${opts.on ? '.on' : ''}`, { type: 'button', disabled: !!opts.disabled, onclick: fn },
      ic ? icon(ic) : null, h('span', label, opts.sub ? h('span.sub', opts.sub) : null),
      val != null ? h('span.val', val, opts.arrow === false ? null : icon('chevR', 'ic-s')) : (opts.tick ? icon('check', 'ic-s tick') : null));
    const rate = this.roomRate ?? this.video.playbackRate;
    const autoNow = this.pref === 'auto' && this.cur ? ` · ${this.cur.label}` : '';
    this.menuMain.replaceChildren(
      item('hd', 'Качество', (this.pref === 'auto' ? `Авто${autoNow}` : this.cur?.label || '—'), () => this.openPage('quality')),
      item('gauge', 'Скорость', rate === 1 ? 'Обычная' : `${rate}×`, () => this.openPage('speed')),
      item('cc', 'Субтитры', this.activeSub ? this.activeSub.label : 'Выкл.', () => this.openPage('subs'), { disabled: !(this.media?.subtitles || []).length }),
      item('zoom', 'Масштаб', `${this.zoom}%`, () => this.openPage('zoom')),
      item('bars', 'Статистика', this.statsOn ? 'Вкл.' : 'Выкл.', () => { this.statsOn = !this.statsOn; this.statsEl.hidden = !this.statsOn; this.paintStats(); this.drawMenu(); }, { arrow: false }),
    );
    const head = (title) => h('div.pmenu-head', h('button.pbtn', { type: 'button', onclick: () => this.openPage(null) }, icon('chevL', 'ic-s')), title);
    const pick = (label, on, fn, opts = {}) => item(null, label, null, fn, { on, tick: true, ...opts });
    let sub = [];
    if (this.menuPage === 'quality') {
      const all = (this.media?.variants || []).filter((v) => v.status !== 'error').slice().sort((a, b) => b.q - a.q || (a.kind === 'source' ? -1 : 1));
      sub = [head('Качество'), pick('Авто', this.pref === 'auto', () => this.setQuality('auto'), { sub: isMobile ? 'до 720p на телефоне' : 'под экран и сеть' })];
      const seen = new Set();
      for (const v of all) {
        if (v.status === 'ready') {
          const ok = canPlay(v);
          if (ok && seen.has(v.q)) continue;
          if (ok) seen.add(v.q);
          sub.push(pick(v.label, this.pref === v.q && ok, () => this.setQuality(v.q), {
            disabled: !ok,
            sub: ok ? `${CODEC[v.codec] || v.codec}${v.kind === 'source' ? ' · исходник' : ''} · ${fmtBytes(v.size)}` : `${CODEC[v.codec] || v.codec} — этот браузер не играет`,
          }));
        } else sub.push(pick(v.label, false, () => {}, { disabled: true, sub: v.status === 'processing' ? `готовится… ${Math.round(v.progress)}%` : 'в очереди' }));
      }
    } else if (this.menuPage === 'speed') {
      sub = [head('Скорость'), ...SPEEDS.map((s) => pick(s === 1 ? 'Обычная' : `${s}×`, Math.abs(rate - s) < 0.01, () => { this.act('rate', s); this.later(() => this.drawMenu(), 60); }))];
    } else if (this.menuPage === 'subs') {
      sub = [head('Субтитры'), pick('Выключены', !this.activeSub, () => this.setSub('off')), ...(this.media?.subtitles || []).map((s) => pick(s.label, this.activeSub?.id === s.id, () => this.setSub(s.id)))];
    } else if (this.menuPage === 'zoom') {
      sub = [head('Масштаб'),
        h('div.pzoom', h('button.pbtn', { type: 'button', onclick: () => this.setZoom(this.zoom - 5) }, icon('minus')), h('b', `${this.zoom}%`), h('button.pbtn', { type: 'button', onclick: () => this.setZoom(this.zoom + 5) }, icon('plus'))),
        pick('Сбросить', this.zoom === 100, () => this.setZoom(100))];
    }
    this.menuSub.replaceChildren(...sub);
    this.menuPages.style.transform = this.menuPage ? 'translateX(-100%)' : '';
  }
  openPage(p) {
    this.menuPage = p;
    this.drawMenu();
  }

  paintStats() {
    if (!this.statsOn) return;
    const v = this.video, c = this.cur;
    const q = v.getVideoPlaybackQuality?.();
    const now = performance.now();
    let fps = 0;
    if (q) {
      if (this.statPrev) fps = ((q.totalVideoFrames - this.statPrev.frames) / (now - this.statPrev.t)) * 1000;
      this.statPrev = { frames: q.totalVideoFrames, t: now };
    }
    const lines = [
      `Версия      ${c ? `${c.label} · ${CODEC[c.codec] || c.codec}${c.kind === 'source' ? ' (исходник)' : ''}` : '—'}`,
      `Разрешение  ${v.videoWidth}×${v.videoHeight}`,
      `Кадры       ${fps > 0 ? fps.toFixed(1) : '—'} / ${c?.fps ? Math.round(c.fps) : '—'} в секунду`,
      `Битрейт     ${c?.bitrate ? `${(c.bitrate / 1e6).toFixed(2)} Мбит/с` : '—'}`,
      `Буфер       ${Math.max(0, this.bufferedEnd() - v.currentTime).toFixed(1)} с`,
      `Пропущено   ${q ? `${q.droppedVideoFrames} из ${q.totalVideoFrames} кадров` : '—'}`,
    ];
    if (this.statExtra) lines.push(this.statExtra());
    this.statsEl.textContent = lines.join('\n');
  }

  // Автопроверка (?autotest): сообщает серверу, что именно играет в этом браузере.
  autotest() {
    if (!new URLSearchParams(location.search).has('autotest')) return;
    this.wantPlay = true;
    this.later(() => { if (!this.room) this.play(); }, 800);
    this.later(() => {
      const v = this.video, q = v.getVideoPlaybackQuality?.();
      post('/api/dev/report', {
        ua: navigator.userAgent, media: this.media?.title, variant: this.cur ? `${this.cur.label} ${this.cur.codec} ${this.cur.codecStr}` : null,
        source: (() => { const s = (this.media?.variants || []).find((x) => x.kind === 'source'); return s ? `${s.label} ${s.codec} canPlay=${canPlay(s)} canPlayType=${probe.canPlayType(`video/mp4; codecs="${s.codecStr}"`)}` : null; })(),
        size: `${v.videoWidth}x${v.videoHeight}`, time: Number(v.currentTime.toFixed(2)), paused: v.paused, muted: v.muted, readyState: v.readyState,
        frames: q ? q.totalVideoFrames : null, dropped: q ? q.droppedVideoFrames : null, error: v.error ? v.error.code : null,
        banner: this.bannerSlot.textContent || null, bad: [...bad],
      }).catch(() => {}).then(() => {
        // цепочка: ?next=id2,id3 — следующий фильм в этой же вкладке
        const rest = (new URLSearchParams(location.search).get('next') || '').split(',').filter(Boolean);
        if (rest.length) location.href = `/watch/${rest[0]}?autotest=1${rest.length > 1 ? `&next=${rest.slice(1).join(',')}` : '&last=1'}`;
        else if (new URLSearchParams(location.search).has('last')) location.href = '/';
      });
    }, 9000);
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.statsTimer);
    clearInterval(this.duckTimer);
    clearTimeout(this.idleTimer);
    for (const t of this.timers) clearTimeout(t);
    for (const off of this.offs) off();
    try { if (document.pictureInPictureElement === this.video) document.exitPictureInPicture(); } catch {}
    try { if (document.fullscreenElement === this.el) document.exitFullscreen(); } catch {}
    if ('mediaSession' in navigator) {
      for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto']) { try { navigator.mediaSession.setActionHandler(a, null); } catch {} }
    }
    try { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); } catch {}
    this.el.remove();
  }
}
