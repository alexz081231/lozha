// Раздел «Музыка»: треки, общая очередь, «сейчас играет».
import { h, kids, fmtTime, fmtSpeed, img } from '../util.js';
import { icon } from '../icons.js';
import { store, bus, rt, tracks, post, patch, del } from '../api.js';
import { seg, menu, toast, confirmDialog, promptDialog, seekline, avatar } from '../ui.js';
import { openAddSheet, uploadsTray, enableDrop } from '../add.js';
import { music, queueList } from '../musicplayer.js';

const canEdit = (t) => store.me.role === 'owner' || t.addedBy === store.me.id;

function trackRow(t, i) {
  const cover = h('button.track-cover', { type: 'button', 'aria-label': 'Играть' });
  const title = h('div.track-title.clip'), sub = h('div.track-sub.clip');
  const end = h('div.track-end');
  const el = h('div.track', { style: { '--i': i } }, cover, h('div', title, sub), end);
  let poster = null, mode = '';
  cover.onclick = () => { if (el._t.status === 'ready') music.playNow(el._t.id); };

  const more = (btn) => menu(btn, [
    { icon: 'play', label: 'Играть сейчас', fn: () => music.playNow(el._t.id) },
    { icon: 'queue', label: 'В конец очереди', fn: () => music.enqueue(el._t.id) },
    canEdit(el._t) ? '-' : null,
    canEdit(el._t) ? { icon: 'edit', label: 'Название и исполнитель', fn: async () => {
      const r = await promptDialog({ title: 'Трек', fields: [{ key: 'title', label: 'Название', value: el._t.title }, { key: 'artist', label: 'Исполнитель', value: el._t.artist }] });
      if (r) patch(`/api/media/${el._t.id}`, r).catch((e) => toast(e.message));
    } } : null,
    canEdit(el._t) ? { icon: 'trash', label: 'Удалить', fn: async () => {
      if (await confirmDialog({ title: 'Удалить трек?', text: `«${el._t.title}» удалится из библиотеки и из очереди.`, ok: 'Удалить' })) del(`/api/media/${el._t.id}`).catch((e) => toast(e.message));
    } } : null,
  ]);

  el.update = (x) => {
    el._t = x;
    const ready = x.status === 'ready';
    title.textContent = x.title;
    if (poster !== x.poster) {
      poster = x.poster;
      cover.replaceChildren(x.poster ? img(x.poster) : icon('music', 'ic-s'), h('span.ov', icon('play', 'ic-s')));
    }
    const cur = store.music?.mediaId === x.id;
    el.classList.toggle('cur', cur);
    if (ready) {
      sub.textContent = x.artist || '—';
      if (mode !== 'ready') {
        mode = 'ready';
        end.replaceChildren(h('span.num'),
          h('button.btn.btn-ghost.btn-icon.btn-s', { type: 'button', title: 'В очередь', onclick: () => music.enqueue(el._t.id) }, icon('plus', 'ic-s')),
          h('button.btn.btn-ghost.btn-icon.btn-s', { type: 'button', title: 'Ещё', onclick: (e) => more(e.currentTarget) }, icon('more', 'ic-s')));
      }
      end.firstChild.textContent = fmtTime(x.duration);
    } else if (x.status === 'error') {
      sub.textContent = x.error;
      if (mode !== 'error') {
        mode = 'error';
        end.replaceChildren(...kids(
          x.retryable && canEdit(x) ? h('button.btn.btn-s', { type: 'button', onclick: () => post(`/api/media/${el._t.id}/retry`).catch((e) => toast(e.message)) }, 'Повторить') : null,
          canEdit(x) ? h('button.btn.btn-ghost.btn-icon.btn-s', { type: 'button', title: 'Удалить', onclick: () => del(`/api/media/${el._t.id}`).catch((e) => toast(e.message)) }, icon('x', 'ic-s')) : null));
      }
    } else {
      mode = 'run';
      sub.textContent = [x.stage || 'В очереди', x.status === 'queued' ? '' : `${Math.floor(x.progress)}%`, x.status === 'downloading' ? fmtSpeed(x.speed) : ''].filter(Boolean).join(' · ');
      end.replaceChildren(...kids(h('span.spin'), canEdit(x) ? h('button.btn.btn-ghost.btn-icon.btn-s', { type: 'button', title: 'Отменить', onclick: () => del(`/api/media/${el._t.id}`).catch((e) => toast(e.message)) }, icon('x', 'ic-s')) : null));
    }
  };
  el.update(t);
  return el;
}

export function musicPage(root) {
  const rows = new Map();
  const list = h('div.tracks');
  const hero = h('div');
  const tray = h('div');
  const queue = queueList();
  const qTitle = h('h2.h2', 'Очередь');
  const cols = h('div.music-cols', { dataset: { tab: 'tracks' } },
    h('section.col-tracks', h('div.sect-title', h('h2.h2', 'Треки')), list),
    h('section.col-queue', h('div.sect-title', qTitle, h('div.grow'),
      h('button.btn.btn-ghost.btn-s', { type: 'button', onclick: async () => { if (store.music?.queue.length && await confirmDialog({ title: 'Очистить очередь?', text: 'Музыка остановится у всех слушателей.', ok: 'Очистить' })) rt.send({ t: 'music:clear' }); } }, 'Очистить')), queue));
  const tabs = seg([{ value: 'tracks', label: 'Треки' }, { value: 'queue', label: 'Очередь' }], 'tracks', (v) => { cols.dataset.tab = v; }, { block: true });
  tabs.classList.add('music-tabs');
  const addBtn = h('span');
  root.append(
    h('header.page-head', h('div', h('div.eyebrow', 'слушаем вместе'), h('h1.h1', 'Музыка')), h('div.page-tools', addBtn)),
    hero, tray, tabs, cols);

  let trayEl = null, dropOff = null;
  function perms() {
    addBtn.replaceChildren(...(store.can.music ? [h('button.btn.btn-primary', { type: 'button', onclick: () => openAddSheet('audio') }, icon('plus', 'ic-s'), 'Добавить')] : []));
    if (store.can.music && !trayEl) { trayEl = uploadsTray('audio'); tray.replaceChildren(trayEl); dropOff = enableDrop('audio', (k) => (k === 'audio' ? store.can.music : store.can.films)); }
    if (!store.can.music && trayEl) { trayEl.destroy(); trayEl = null; tray.replaceChildren(); dropOff?.(); dropOff = null; }
  }

  // «Сейчас играет»
  let heroParts = null;
  function drawHero() {
    const s = store.music;
    const t = s?.mediaId ? store.media.get(s.mediaId) : null;
    if (!t) { hero.replaceChildren(); heroParts = null; return; }
    if (!heroParts) {
      const bg = h('div.hero-bg'), cover = h('div.hero-cover');
      const eye = h('div.eyebrow'), title = h('div.hero-title'), artist = h('div.muted');
      const line = seekline({ onSeek: (x) => music.seek(x) });
      const ctl = h('div.hero-ctl');
      heroParts = { bg, cover, eye, title, artist, line, ctl, poster: null, mode: '' };
      hero.replaceChildren(h('div.hero', bg, cover, h('div', { style: { minWidth: 0 } }, eye, title, artist, line, ctl)));
    }
    const p = heroParts;
    p.title.textContent = t.title;
    p.artist.textContent = t.artist || '';
    p.eye.textContent = s.playing ? (s.waiting ? 'синхронизация…' : 'сейчас играет') : 'на паузе';
    if (p.poster !== t.poster) {
      p.poster = t.poster;
      p.cover.replaceChildren(t.poster ? img(t.poster) : icon('music', 'ic-l'));
      p.bg.style.backgroundImage = t.poster ? `url("${t.poster}")` : '';
      p.bg.classList.toggle('ok', !!t.poster);
    }
    const who = store.rooms.find((r) => r.kind === 'music')?.viewers || [];
    const mode = `${music.joined}|${s.playing}|${music.blocked}|${who.map((v) => v.id).join()}`;
    if (p.mode !== mode) {
      p.mode = mode;
      const listeners = who.length ? h('div.row', h('div.stack', who.slice(0, 5).map((v) => avatar(v, 's'))), h('span.small.muted', who.length === 1 ? `слушает ${who[0].name}` : `слушают: ${who.length}`)) : null;
      p.ctl.replaceChildren(...kids(music.joined ? [
        h('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': 'Предыдущий', onclick: () => music.prev() }, icon('prev', 'ic-s')),
        h('button.btn.btn-primary.btn-icon', { type: 'button', 'aria-label': 'Играть / пауза', onclick: () => music.toggle() }, icon(s.playing && !music.blocked ? 'pause' : 'play', 'ic-s')),
        h('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': 'Следующий', onclick: () => music.next() }, icon('next', 'ic-s')),
        h('button.btn', { type: 'button', onclick: () => music.openNow() }, 'Открыть плеер'),
        listeners,
      ] : [
        h('button.btn.btn-primary', { type: 'button', onclick: () => music.join() }, icon('phones', 'ic-s'), 'Слушать вместе'),
        listeners,
      ]));
    }
    p.line.set(music.position(), t.duration || 0);
  }

  function rebuild() {
    rows.clear();
    const all = tracks();
    if (!all.length) {
      list.replaceChildren(store.mediaLoaded
        ? h('div.empty', icon('music'), h('p', store.can.music ? 'Музыки пока нет. Загрузи треки или добавь по ссылке с YouTube и SoundCloud.' : 'Музыки пока нет.'))
        : h('div.col', Array.from({ length: 6 }, () => h('div.skeleton', { style: { height: '62px' } }))));
      return;
    }
    list.replaceChildren(...all.map((t, i) => { const r = trackRow(t, i); rows.set(t.id, r); return r; }));
  }

  const paintQueueTitle = () => {
    const n = store.music?.queue.length || 0;
    qTitle.textContent = n ? `Очередь · ${n}` : 'Очередь';
    tabs.label('queue', n ? `Очередь · ${n}` : 'Очередь');
  };

  const timer = setInterval(() => { if (heroParts) { const t = store.media.get(store.music?.mediaId); if (t) heroParts.line.set(music.position(), t.duration || 0); } }, 500);
  const offs = [
    bus.on('media', (m) => {
      if (m.kind !== 'audio') return;
      const r = rows.get(m.id);
      if (r) r.update(m); else rebuild();
      if (m.id === store.music?.mediaId) drawHero();
    }),
    bus.on('media:gone', (id) => { if (rows.has(id)) rebuild(); }),
    bus.on('media:reset', () => { rebuild(); drawHero(); }),
    bus.on('music', () => { drawHero(); paintQueueTitle(); for (const r of rows.values()) r.classList.toggle('cur', store.music?.mediaId === r._t.id); }),
    bus.on('music:joined', drawHero),
    bus.on('rooms', drawHero),
    bus.on('perms:changed', perms),
  ];
  perms();
  rebuild();
  drawHero();
  paintQueueTitle();

  return () => {
    clearInterval(timer);
    for (const off of offs) off();
    queue.destroy();
    trayEl?.destroy();
    dropOff?.();
  };
}
