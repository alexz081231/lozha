// Общие элементы интерфейса: тосты, листы, меню, движущиеся пилюли, диалоги.
import { h, $, initials } from './util.js';
import { icon } from './icons.js';

// ── Тосты ─────────────────────────────────────────────────────────────────
export function toast(text, opts = {}) {
  const host = $('#toasts');
  while (host.children.length >= 4) host.firstElementChild.remove();
  let gone = false;
  const close = () => {
    if (gone) return;
    gone = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  };
  const el = h('div.toast', { role: 'status' },
    opts.img ? h('img', { src: opts.img, alt: '' }) : null,
    h('span', text),
    opts.action ? h('button.btn.btn-primary', { onclick: () => { close(); opts.action.fn(); } }, opts.action.label) : null);
  host.append(el);
  void el.offsetWidth;
  el.classList.add('in');
  setTimeout(close, opts.timeout || (opts.action ? 9000 : 3400));
  return close;
}

// ── Движущаяся пилюля: подсветка плавно переезжает к активному пункту ─────
export function pill(container, selector = ':scope > .on') {
  let el = container.querySelector(':scope > .pill');
  if (!el) { el = h('span.pill.still'); container.prepend(el); }
  let placed = false;
  const update = (animate = true) => {
    const on = container.querySelector(selector);
    if (!on || !on.offsetWidth) { el.classList.remove('shown'); return; }
    const jump = !placed || !animate;
    if (jump) el.classList.add('still');
    el.style.width = `${on.offsetWidth}px`;
    el.style.height = `${on.offsetHeight}px`;
    el.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
    el.classList.add('shown');
    if (jump) { void el.offsetWidth; el.classList.remove('still'); }
    placed = true;
  };
  const ro = new ResizeObserver(() => update(false));
  ro.observe(container);
  update(false);
  return { update, destroy: () => ro.disconnect() };
}

// Сегментированный переключатель.
export function seg(items, value, onChange, { block = false } = {}) {
  const el = h(`div.seg${block ? '.seg-block' : ''}`, { role: 'tablist' });
  const btns = items.map((it) => h('button', {
    type: 'button', role: 'tab', dataset: { v: String(it.value) }, onclick: () => { if (String(value) !== String(it.value)) set(it.value, true); },
  }, it.icon ? icon(it.icon, 'ic-s') : null, it.label != null ? h('span', it.label) : null));
  el.append(...btns);
  const p = pill(el);
  function set(v, fire) {
    value = v;
    for (const b of btns) {
      const on = b.dataset.v === String(v);
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
    }
    p.update();
    if (fire) onChange?.(v);
  }
  set(value, false);
  el.set = (v) => set(v, false);
  el.label = (v, text) => { const b = btns.find((x) => x.dataset.v === String(v)); if (b) { b.querySelector('span').textContent = text; p.update(false); } };
  return el;
}

// ── Листы ─────────────────────────────────────────────────────────────────
const openSheets = new Set();
// При переходе на другую страницу открытые листы и меню закрываются.
export function closeOverlays() {
  for (const close of [...openSheets]) close();
  closeMenu?.();
}

let locks = 0;
const lock = () => { if (++locks === 1) document.documentElement.classList.add('locked'); };
const unlock = () => { if (--locks <= 0) { locks = 0; document.documentElement.classList.remove('locked'); } };

export function sheet({ title, body, foot, wide = false, onClose, dismissable = true }) {
  let closed = false;
  const bodyEl = h('div.sheet-body', body);
  const footEl = foot ? h('div.sheet-foot', foot) : null;
  const titleEl = h('div.h2', title);
  const grab = h('div.sheet-grab');
  const head = h('div.sheet-head', titleEl, dismissable ? h('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': 'Закрыть', onclick: () => close() }, icon('x')) : null);
  const el = h(`div.sheet${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true' }, grab, head, bodyEl, footEl);
  const wrap = h('div.sheet-wrap', el);
  let downOnWrap = false;
  wrap.addEventListener('pointerdown', (e) => { downOnWrap = e.target === wrap; });
  wrap.addEventListener('click', (e) => { if (e.target === wrap && downOnWrap && dismissable) close(); });

  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable && wrap === $('#layer').lastElementChild) { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey);

  // Смахивание вниз на телефоне.
  let sy = null, dy = 0;
  const dragStart = (e) => { if (matchMedia('(max-width: 640px)').matches && dismissable) { sy = e.touches[0].clientY; dy = 0; el.style.transition = 'none'; } };
  const dragMove = (e) => {
    if (sy == null) return;
    dy = Math.max(0, e.touches[0].clientY - sy);
    el.style.transform = `translateY(${dy}px)`;
  };
  const dragEnd = () => {
    if (sy == null) return;
    sy = null;
    el.style.transition = '';
    el.style.transform = '';
    if (dy > 90) close();
  };
  for (const part of [grab, head]) {
    part.addEventListener('touchstart', dragStart, { passive: true });
    part.addEventListener('touchmove', dragMove, { passive: true });
    part.addEventListener('touchend', dragEnd);
  }

  $('#layer').append(wrap);
  lock();
  void wrap.offsetWidth;
  wrap.classList.add('in');
  setTimeout(() => {
    const first = el.querySelector('[autofocus], .sheet-body input:not([type=file]), .sheet-body textarea');
    if (first && !matchMedia('(pointer: coarse)').matches) first.focus({ preventScroll: true });
  }, 60);

  function close(result) {
    if (closed) return;
    closed = true;
    openSheets.delete(close);
    document.removeEventListener('keydown', onKey);
    wrap.classList.remove('in');
    wrap.classList.add('out');
    unlock();
    setTimeout(() => wrap.remove(), 300);
    onClose?.(result);
  }
  openSheets.add(close);
  return { el, body: bodyEl, foot: footEl, close, setTitle: (t) => { titleEl.textContent = t; }, get closed() { return closed; } };
}

export function confirmDialog({ title, text, ok = 'Да', cancel = 'Отмена' }) {
  return new Promise((resolve) => {
    let done = false;
    const s = sheet({
      title,
      body: text ? h('p.muted', { style: { margin: 0 } }, text) : null,
      foot: [
        h('button.btn.btn-ghost', { type: 'button', onclick: () => s.close() }, cancel),
        h('button.btn.btn-primary', { type: 'button', autofocus: true, onclick: () => { done = true; s.close(); } }, ok),
      ],
      onClose: () => resolve(done),
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', ok = 'Сохранить', fields }) {
  return new Promise((resolve) => {
    let result = null;
    const defs = fields || [{ key: 'value', label, value, placeholder }];
    const inputs = defs.map((f) => h('input.input', { value: f.value || '', placeholder: f.placeholder || '', maxLength: f.max || 300, autocomplete: 'off' }));
    const submit = () => {
      const out = {};
      defs.forEach((f, i) => { out[f.key] = inputs[i].value.trim(); });
      if (defs[0].required !== false && !out[defs[0].key]) { inputs[0].classList.add('bad'); setTimeout(() => inputs[0].classList.remove('bad'), 400); return; }
      result = fields ? out : out.value;
      s.close();
    };
    const form = h('form', { style: { display: 'flex', flexDirection: 'column', gap: '12px' }, onsubmit: (e) => { e.preventDefault(); submit(); } },
      defs.map((f, i) => h('label.field', f.label ? h('span', f.label) : null, inputs[i])));
    const s = sheet({
      title,
      body: form,
      foot: [h('button.btn.btn-ghost', { type: 'button', onclick: () => s.close() }, 'Отмена'), h('button.btn.btn-primary', { type: 'button', onclick: submit }, ok)],
      onClose: () => resolve(result),
    });
    setTimeout(() => inputs[0].select?.(), 80);
  });
}

// ── Меню ──────────────────────────────────────────────────────────────────
let closeMenu = null;
export function menu(anchor, items) {
  closeMenu?.();
  const el = h('div.menu', { role: 'menu' }, items.filter(Boolean).map((it) => (it === '-' ? h('hr')
    : h('button', { type: 'button', role: 'menuitem', onclick: () => { close(); it.fn(); } }, it.icon ? icon(it.icon) : null, it.label))));
  $('#layer').append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, hh = el.offsetHeight;
  const x = Math.min(innerWidth - w - 8, Math.max(8, r.right - w));
  let y = r.bottom + 6, origin = '100% 0';
  if (y + hh > innerHeight - 8) { y = Math.max(8, r.top - hh - 6); origin = '100% 100%'; }
  Object.assign(el.style, { left: `${x}px`, top: `${y}px`, transformOrigin: origin });
  void el.offsetWidth;
  el.classList.add('in');
  const onDown = (e) => { if (!el.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    if (closeMenu !== close) return;
    closeMenu = null;
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
    removeEventListener('resize', close);
    removeEventListener('scroll', close, true);
    el.classList.remove('in');
    setTimeout(() => el.remove(), 180);
  }
  closeMenu = close;
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    addEventListener('resize', close);
    addEventListener('scroll', close, true);
  }, 0);
  return close;
}

// ── Прочее ────────────────────────────────────────────────────────────────
export function avatar(user, cls = '') {
  const el = h(`div.avatar${cls ? `.${cls}` : ''}`, { title: user?.name || '' });
  if (user?.avatar) {
    const im = h('img', { alt: '', src: user.avatar });
    im.addEventListener('error', () => { im.remove(); el.textContent = initials(user.name); });
    el.append(im);
  } else el.textContent = initials(user?.name);
  return el;
}

export function busy(btn, on) {
  if (on) {
    if (!btn.querySelector(':scope > .spin')) btn.append(h('span.spin'));
    btn.classList.add('busy');
  } else {
    btn.classList.remove('busy');
    btn.querySelector(':scope > .spin')?.remove();
  }
}

export function alertBox(text, extra) {
  return h('div.alert', icon('warn', 'ic-s'), h('div.grow', text, extra || null));
}

export function range(value, { min = 0, max = 100, step = 1, oninput, cls = '' } = {}) {
  const el = h(`input.rng${cls ? `.${cls}` : ''}`, { type: 'range', min, max, step, value });
  const paint = () => el.style.setProperty('--v', `${((el.value - min) / (max - min)) * 100}%`);
  el.addEventListener('input', () => { paint(); oninput?.(Number(el.value)); });
  el.set = (v) => { el.value = v; paint(); };
  paint();
  return el;
}

// Полоса перемотки для музыки: тянется мышью и пальцем.
export function seekline({ onSeek }) {
  const fill = h('i'), knob = h('b');
  const bar = h('div.bar', fill, knob);
  const cur = h('span.num', '0:00'), total = h('span.num', '0:00');
  const el = h('div.seekline', cur, bar, total);
  let dragging = false, dur = 0;
  const frac = (e) => { const r = bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const paint = (f) => { fill.style.width = `${f * 100}%`; knob.style.left = `${f * 100}%`; };
  bar.addEventListener('pointerdown', (e) => {
    if (!dur) return;
    dragging = true;
    bar.classList.add('drag');
    bar.setPointerCapture(e.pointerId);
    paint(frac(e));
  });
  bar.addEventListener('pointermove', (e) => { if (dragging) { const f = frac(e); paint(f); cur.textContent = fmt(f * dur); } });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('drag');
    onSeek?.(frac(e) * dur);
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', () => { dragging = false; bar.classList.remove('drag'); });
  const fmt = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  el.set = (t, d) => {
    dur = d || 0;
    total.textContent = fmt(dur);
    if (dragging) return;
    cur.textContent = fmt(t);
    paint(dur ? Math.min(1, t / dur) : 0);
  };
  return el;
}
