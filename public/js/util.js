// Мелкие помощники: DOM, форматирование, окружение.

// h('div.card.big', { onclick }, child, 'текст') — весь пользовательский текст попадает в DOM как текст, не как HTML.
export function h(sel, attrs, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = null;
  }
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'class') el.className = `${el.className} ${v}`.trim();
    else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const kid of kids) {
    if (kid == null || kid === false || kid === true) continue;
    if (Array.isArray(kid)) add(el, kid);
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

// Для родных append/replaceChildren: они превращают null в текст «null», поэтому пустое отсеиваем.
export const kids = (...a) => a.flat(Infinity).filter((x) => x != null && x !== false);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

const ua = navigator.userAgent || '';
export const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/i.test(ua);
export const isMobile = isIOS || isAndroid || /Mobi/i.test(ua);
export const isSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
export const isTouch = matchMedia('(pointer: coarse)').matches;
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return hh ? `${hh}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export function fmtDur(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec} с`;
  const hh = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return hh ? (m ? `${hh} ч ${m} мин` : `${hh} ч`) : `${m} мин`;
}
export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${u[i]}`;
}
export const fmtSpeed = (bps) => (bps > 0 ? `${fmtBytes(bps)}/с` : '');
export function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `осталось ${Math.max(1, Math.round(sec))} с`;
  if (sec < 3600) return `осталось ${Math.round(sec / 60)} мин`;
  return `осталось ${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин`;
}
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
export const initials = (name) => {
  const parts = String(name || '?').trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
};

export const ls = {
  get(k, d = null) {
    try { const v = localStorage.getItem(`lozha.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem(`lozha.${k}`, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(`lozha.${k}`); } catch {} },
};

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function emitter() {
  const map = new Map();
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    emit(type, ...args) {
      for (const fn of [...(map.get(type) || [])]) {
        try { fn(...args); } catch (e) { console.error(e); }
      }
    },
  };
}

// Картинка, которая не дёргает вёрстку: место занято заранее, появляется плавно.
export function img(src, cls = '') {
  const el = h('img', { alt: '', loading: 'lazy', decoding: 'async', class: cls, referrerPolicy: 'no-referrer' });
  el.addEventListener('load', () => el.classList.add('ok'), { once: true });
  el.addEventListener('error', () => el.remove(), { once: true });
  el.src = src;
  return el;
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0', top: '0' } });
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}
