// Библиотека фильмов: карточки со статусом в реальном времени.
import { h, kids, fmtTime, fmtBytes, fmtSpeed, fmtEta, img, ls, debounce } from '../util.js';
import { icon } from '../icons.js';
import { store, bus, films, get, post, patch, del } from '../api.js';
import { seg, menu, toast, confirmDialog, promptDialog, busy } from '../ui.js';
import { nav } from '../nav.js';
import { mountNow } from '../now.js';
import { openAddSheet, uploadsTray, enableDrop } from '../add.js';

const inWork = (m) => m.status !== 'ready' || (m.variants || []).some((v) => v.status === 'queued' || v.status === 'processing');

export async function openFilm(id) {
  const m = store.media.get(id);
  if (!m || m.status !== 'ready') return;
  try {
    if (store.me.role === 'owner') {
      const r = await post('/api/rooms', { mediaId: id }); // повторное «Смотреть» вернёт уже идущую комнату
      nav.go(`/room/${r.id}`);
    } else {
      const r = await get(`/api/rooms/for/${id}`);
      nav.go(r.room ? `/room/${r.room}` : `/watch/${id}`);
    }
  } catch (e) { toast(e.message); }
}

function filmCard(m, i) {
  const owner = store.me.role === 'owner';
  const el = h('article.film', { style: { '--i': Math.min(i, 16) } });
  const badges = h('div.film-badges');
  const dur = h('span.chip.film-dur.num');
  const live = h('span.film-live', h('i'), 'смотрят');
  const play = h('span.film-play', icon('play'));
  const work = h('div.film-work');
  const media = h('button.film-media', { type: 'button', onclick: () => openFilm(el._m.id) }, h('div.ph', icon('film')), badges, dur, live, play, work);
  const title = h('div.film-title');
  const meta = h('div.film-meta.num');
  const more = owner ? h('button.btn.btn-ghost.btn-icon.btn-s.film-more', { type: 'button', 'aria-label': 'Действия', onclick: (e) => { e.stopPropagation(); openMenu(); } }, icon('more')) : null;
  el.append(media, h('div.film-body', h('div.grow', title, meta), more));
  let poster = null, workMode = '';

  function openMenu() {
    const cur = el._m;
    const busyNow = ['queued', 'downloading', 'processing'].includes(cur.status);
    menu(more, [
      cur.status === 'ready' ? { icon: 'play', label: 'Смотреть', fn: () => openFilm(cur.id) } : null,
      cur.status === 'error' && cur.retryable ? { icon: 'refresh', label: 'Повторить', fn: () => post(`/api/media/${cur.id}/retry`).catch((e) => toast(e.message)) } : null,
      { icon: 'edit', label: 'Переименовать', fn: async () => {
        const name = await promptDialog({ title: 'Название фильма', value: cur.title });
        if (name && name !== cur.title) patch(`/api/media/${cur.id}`, { title: name }).catch((e) => toast(e.message));
      } },
      '-',
      { icon: busyNow ? 'x' : 'trash', label: busyNow ? 'Отменить загрузку' : 'Удалить', fn: async () => {
        const ok = await confirmDialog({
          title: busyNow ? 'Отменить загрузку?' : 'Удалить фильм?',
          text: busyNow ? `«${cur.title}» перестанет скачиваться, временные файлы удалятся.` : `«${cur.title}» и все его версии качества удалятся с диска. Вернуть не получится.`,
          ok: busyNow ? 'Отменить загрузку' : 'Удалить', cancel: 'Оставить',
        });
        if (ok) del(`/api/media/${cur.id}`).catch((e) => toast(e.message));
      } },
    ]);
  }

  el.update = (x) => {
    el._m = x;
    const ready = x.status === 'ready';
    el.classList.toggle('ready', ready);
    el.classList.toggle('busy', !ready);
    media.disabled = !ready;
    title.textContent = x.title;
    if (poster !== x.poster) {
      poster = x.poster;
      media.querySelector(':scope > img')?.remove();
      if (x.poster) media.prepend(img(x.poster));
    }
    const vs = (x.variants || []).slice().sort((a, b) => b.q - a.q);
    const src = vs.find((v) => v.kind === 'source');
    badges.replaceChildren(...(ready && src ? [h('span.chip', src.label)] : []));
    dur.hidden = !ready || !x.duration;
    dur.textContent = fmtTime(x.duration);
    live.hidden = !store.rooms.some((r) => r.mediaId === x.id);
    play.hidden = !ready;

    if (ready) {
      work.hidden = true;
      workMode = '';
      const parts = vs.filter((v) => v.status !== 'error').map((v) => (v.status === 'ready'
        ? h('span.q', v.label)
        : h('span.q.pending', `${v.label}${v.status === 'processing' ? ` ${Math.round(v.progress)}%` : ' …'}`)));
      meta.replaceChildren(...parts.flatMap((p, k) => (k ? [' · ', p] : [p])));
    } else {
      work.hidden = false;
      meta.textContent = x.status === 'error' ? 'Ошибка' : (x.stage || 'В очереди');
      if (x.status === 'error') {
        if (workMode !== 'error') {
          workMode = 'error';
          work.replaceChildren(...kids(icon('warn'), h('div.err'), owner && x.retryable
            ? h('button.btn.btn-s', { type: 'button', onclick: (e) => { e.stopPropagation(); busy(e.currentTarget, true); post(`/api/media/${el._m.id}/retry`).catch((er) => toast(er.message)); } }, h('span', 'Повторить')) : null));
        }
        work.querySelector('.err').textContent = x.error;
      } else {
        if (workMode !== 'run') {
          workMode = 'run';
          work.replaceChildren(h('div.pct.num'), h('div.meter', h('i')), h('div.stage'));
        }
        const queued = x.status === 'queued';
        work.querySelector('.pct').textContent = queued ? '…' : `${Math.floor(x.progress)}%`;
        work.querySelector('.meter').classList.toggle('busy', queued || (x.progress <= 0 && x.status !== 'downloading'));
        work.querySelector('.meter > i').style.width = `${x.progress}%`;
        work.querySelector('.stage').textContent = [x.stage || (queued ? 'В очереди' : ''), x.status === 'downloading' ? fmtSpeed(x.speed) : '', x.status === 'downloading' ? fmtEta(x.eta) : ''].filter(Boolean).join(' · ');
      }
    }
  };
  el.update(m);
  return el;
}

export function libraryPage(root) {
  const owner = store.me.role === 'owner';
  let filter = ls.get('filter', 'all');
  const cards = new Map();
  const grid = h('div.grid');
  const emptyBox = h('div');
  const strip = h('div.now-strip');
  const tray = owner ? uploadsTray('video') : null;
  const disk = owner ? h('div.disk', { hidden: true }) : null;

  const filterSeg = seg([{ value: 'all', label: 'Все' }, { value: 'ready', label: 'Готовые' }, { value: 'work', label: 'В работе' }], filter, (v) => { filter = v; ls.set('filter', v); rebuild(); });
  root.append(...kids(
    h('header.page-head',
      h('div', h('div.eyebrow', owner ? 'твоя библиотека' : 'библиотека'), h('h1.h1', 'Фильмы')),
      h('div.page-tools', filterSeg, owner ? h('button.btn.btn-primary', { type: 'button', onclick: () => openAddSheet('video') }, icon('plus', 'ic-s'), 'Добавить') : null)),
    strip, disk, tray, grid, emptyBox,
  ));

  const match = (m) => filter === 'all' || (filter === 'ready' ? m.status === 'ready' : inWork(m));

  function skeletons() {
    grid.replaceChildren(...Array.from({ length: 8 }, () => h('div.film', h('div.skeleton', { style: { aspectRatio: '16 / 9', borderRadius: 'var(--r-l)' } }),
      h('div.skeleton', { style: { height: '16px', width: '70%', margin: '0 4px' } }), h('div.skeleton', { style: { height: '12px', width: '40%', margin: '0 4px' } }))));
  }

  function checkEmpty() {
    if (cards.size) { emptyBox.replaceChildren(); return; }
    const total = films().length;
    emptyBox.replaceChildren(h('div.empty', icon('film'),
      total ? h('p', filter === 'work' ? 'Сейчас ничего не скачивается и не обрабатывается.' : 'Готовых фильмов пока нет.')
        : owner ? h('p', 'Здесь пока пусто. Добавь первый фильм — по ссылке с YouTube, Rutube, VK или файлом с компьютера.')
          : h('p', 'Владелец ещё ничего не добавил. Загляни позже.'),
      !total && owner ? h('button.btn.btn-primary.btn-l', { type: 'button', onclick: () => openAddSheet('video') }, icon('plus', 'ic-s'), 'Добавить фильм') : null));
  }

  function rebuild() {
    cards.clear();
    const list = films().filter(match);
    grid.replaceChildren(...list.map((m, i) => { const c = filmCard(m, i); cards.set(m.id, c); return c; }));
    checkEmpty();
  }

  const refreshDisk = debounce(async () => {
    if (!owner) return;
    try {
      const s = await get('/api/system');
      const total = s.disk.used + s.disk.free;
      disk.hidden = false;
      disk.replaceChildren(icon('disk', 'ic-s'), h('span.num', `Занято ${fmtBytes(s.disk.used)}`), h('div.meter', h('i', { style: { width: `${total ? Math.max(1.5, (s.disk.used / total) * 100) : 0}%` } })), h('span.num', `свободно ${fmtBytes(s.disk.free)}`));
    } catch {}
  }, 600);

  const offs = [
    bus.on('media', (m) => {
      if (m.kind !== 'video') return;
      const c = cards.get(m.id);
      if (c) {
        if (!match(m)) { cards.delete(m.id); c.classList.add('gone'); setTimeout(() => { c.remove(); checkEmpty(); }, 300); }
        else c.update(m);
      } else if (match(m)) {
        const card = filmCard(m, 0);
        cards.set(m.id, card);
        grid.prepend(card);
        checkEmpty();
      }
      if (m.status === 'ready' || m.status === 'error') refreshDisk();
    }),
    bus.on('media:gone', (id) => {
      const c = cards.get(id);
      if (!c) return;
      cards.delete(id);
      c.classList.add('gone');
      setTimeout(() => { c.remove(); checkEmpty(); }, 300);
      refreshDisk();
    }),
    bus.on('media:reset', rebuild),
    bus.on('rooms', () => { for (const c of cards.values()) c.update(c._m); }),
    mountNow(strip),
    owner ? enableDrop('video', (k) => (k === 'video' ? store.can.films : store.can.music)) : null,
  ];

  if (store.mediaLoaded) rebuild(); else skeletons();
  refreshDisk();

  return () => {
    for (const off of offs) off?.();
    tray?.destroy();
  };
}
