// «Смотрят сейчас»: живой список комнат. Карточки обновляются на месте, без мигания.
import { h, fmtTime, img } from './util.js';
import { icon } from './icons.js';
import { store, bus, rt } from './api.js';
import { nav } from './nav.js';
import { music } from './musicplayer.js';

const posOf = (r) => Math.min(r.duration || 1e9, r.position + (r.playing ? ((rt.now() - r.at) / 1000) * r.rate : 0));

function paint(el) {
  const r = el._r;
  const names = r.viewers.map((v) => v.name).join(', ');
  el._meta.textContent = `${r.kind === 'music' ? (r.playing ? 'играет' : 'пауза') : `${r.playing ? 'идёт' : 'пауза'} · ${fmtTime(posOf(r))}`} · ${names}`;
  el._title.textContent = r.kind === 'music' && r.artist ? `${r.artist} — ${r.title}` : r.title;
  el._state.replaceChildren(icon(r.playing ? 'play' : 'pause'));
  if (el._poster !== r.poster) {
    el._poster = r.poster;
    el._thumb.querySelector('img')?.remove();
    if (r.poster) el._thumb.prepend(img(r.poster));
  }
}

function card(r) {
  const state = h('span.state');
  const thumb = h(`div.now-thumb${r.kind === 'music' ? '.sq' : ''}`, icon(r.kind === 'music' ? 'music' : 'film'), state);
  const title = h('div.now-title');
  const meta = h('div.now-meta.num');
  const el = h('button.now-card', {
    type: 'button',
    onclick: () => {
      const cur = el._r;
      if (cur.kind === 'music') { nav.go('/music'); music.join(); } else nav.go(`/room/${cur.id}`);
    },
  }, thumb, h('div', title, meta));
  Object.assign(el, { _r: r, _thumb: thumb, _title: title, _meta: meta, _state: state, _poster: null });
  paint(el);
  return el;
}

export function mountNow(container, { emptyText = '' } = {}) {
  const els = new Map();
  let empty = null;
  const render = () => {
    const seen = new Set();
    for (const r of store.rooms) {
      seen.add(r.id);
      let el = els.get(r.id);
      if (!el) { el = card(r); els.set(r.id, el); container.append(el); }
      else { el._r = r; paint(el); }
    }
    for (const [id, el] of els) if (!seen.has(id)) { el.remove(); els.delete(id); }
    if (!store.rooms.length && emptyText) {
      if (!empty) { empty = h('div.now-empty', emptyText); container.append(empty); }
    } else if (empty) { empty.remove(); empty = null; }
  };
  const off = bus.on('rooms', render);
  const timer = setInterval(() => { for (const el of els.values()) if (el._r.playing) paint(el); }, 1000);
  render();
  return () => { off(); clearInterval(timer); };
}
