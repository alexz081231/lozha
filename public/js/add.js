// Лист «Добавить»: по ссылке (yt-dlp на сервере) или файлами. Плюс лента загрузок и перетаскивание в окно.
import { h, kids, fmtBytes, fmtTime, fmtSpeed, fmtEta, img } from './util.js';
import { icon } from './icons.js';
import { store, post } from './api.js';
import { sheet, seg, pill, toast, busy, alertBox } from './ui.js';
import { uploads } from './upload.js';
import { nav } from './nav.js';

const ACCEPT = {
  video: 'video/*,.mkv,.avi,.mov,.webm,.ts,.m2ts,.m4v,.flv,.wmv,.mpg,.mpeg,.3gp,.ogv',
  audio: 'audio/*,.mp3,.flac,.m4a,.ogg,.oga,.opus,.wav,.aac,.wma',
};
const AUDIO_EXT = /\.(mp3|flac|m4a|ogg|oga|opus|wav|aac|wma|aiff?)$/i;

function startFiles(files, kind) {
  let n = 0;
  for (const f of files) {
    if (!f || !f.size) continue;
    uploads.add(f, kind);
    n++;
  }
  if (n) toast(n === 1 ? 'Загрузка началась' : `Загружаю файлы: ${n}`);
  return n;
}

export function openAddSheet(kind = 'video') {
  const isAudio = kind === 'audio';
  const pane = h('div.col', { style: { gap: '16px' } });
  let tab = 'link';
  const tabs = seg([{ value: 'link', label: 'По ссылке', icon: 'link' }, { value: 'file', label: 'Файлы', icon: 'upload' }], tab, (v) => { tab = v; draw(); }, { block: true });
  const s = sheet({ title: isAudio ? 'Добавить музыку' : 'Добавить фильм', body: [tabs, pane], wide: true });

  // ── По ссылке ───────────────────────────────────────────────────────────
  const input = h('input.input', { type: 'url', inputMode: 'url', placeholder: isAudio ? 'Ссылка: YouTube, SoundCloud…' : 'Ссылка: YouTube, Rutube, VK Видео, Дзен, OK, .mp4, .m3u8…', autocomplete: 'off', spellcheck: false });
  const go = h('button.btn.btn-primary', { type: 'submit' }, h('span', 'Найти'));
  const result = h('div.col', { style: { gap: '14px' } });
  let reqId = 0;

  const loading = () => result.replaceChildren(
    h('div.preview', h('div.preview-thumb.skeleton'), h('div.steps', h('div.skeleton', { style: { width: '90%', height: '20px' } }), h('div.skeleton', { style: { width: '50%' } }), h('div.skeleton', { style: { width: '70%' } }))),
    h('div.hint', 'Разбираю ссылку — обычно это 5–15 секунд…'),
  );

  async function resolve(url) {
    url = String(url || '').trim();
    if (!url) { input.classList.add('bad'); setTimeout(() => input.classList.remove('bad'), 400); return; }
    const my = ++reqId;
    busy(go, true);
    loading();
    try {
      const r = await post('/api/links/resolve', { url, kind });
      if (my !== reqId || s.closed) return;
      show(r);
    } catch (e) {
      if (my !== reqId || s.closed) return;
      const needCookies = ['login', 'bot'].includes(e.data?.code) && store.me.role === 'owner';
      result.replaceChildren(alertBox(e.message, needCookies ? h('div', { style: { marginTop: '8px' } },
        h('button.btn.btn-s.btn-primary', { type: 'button', onclick: () => { s.close(); nav.go('/settings'); } }, 'Открыть настройки')) : null));
    } finally { if (my === reqId) busy(go, false); }
  }

  function show(r) {
    if (r.type === 'list') {
      result.replaceChildren(
        h('div.small.muted', `На странице несколько видео — выбери нужное (${r.entries.length}):`),
        h('div.entries', r.entries.map((e) => h('button.entry', { type: 'button', onclick: () => { input.value = e.url; resolve(e.url); } },
          h('div.preview-thumb', icon('film'), e.thumbnail ? img(e.thumbnail) : null, e.duration ? h('span.chip.num', fmtTime(e.duration)) : null),
          h('div', h('div.film-title', e.title), e.uploader ? h('div.small.faint.clip', e.uploader) : null)))),
      );
      return;
    }
    let chosen = null;
    const dl = h('button.btn.btn-primary.btn-l.btn-block', { type: 'button' }, h('span'));
    const label = dl.firstChild;
    const parts = [h('div.preview',
      h('div.preview-thumb', icon(isAudio ? 'music' : 'film'), r.thumbnail ? img(r.thumbnail) : null, r.duration ? h('span.chip.num', fmtTime(r.duration)) : null),
      h('div.col', { style: { gap: '6px' } },
        h('div.preview-title', r.title),
        h('div.small.muted', [r.site, r.uploader].filter(Boolean).join(' · ') || ' ')))];

    if (isAudio) {
      label.textContent = `Добавить трек${r.audioSize ? ` · ${fmtBytes(r.audioSize)}` : ''}`;
    } else if (r.hasVideo === false) {
      parts.push(alertBox('По этой ссылке только звук — добавь её в разделе «Музыка».'));
      dl.disabled = true;
      label.textContent = 'Скачать';
    } else {
      const qs = r.qualities;
      chosen = qs.find((q) => q.q && q.q <= 1080) || qs[0]; // по умолчанию — лучшее до 1080p
      const grid = h('div.quals');
      const setLabel = () => { label.textContent = `Скачать ${chosen.label}${chosen.size ? ` · ${chosen.approx ? '≈ ' : ''}${fmtBytes(chosen.size)}` : ''}`; };
      const btns = qs.map((q) => h('button', { type: 'button', onclick: () => { chosen = q; mark(); } },
        h('b', q.label), h('span', q.size ? `${q.approx ? '≈ ' : ''}${fmtBytes(q.size)}` : (q.codec || '—'))));
      grid.append(...btns);
      const p = pill(grid);
      const mark = () => { btns.forEach((b, i) => b.classList.toggle('on', qs[i] === chosen)); p.update(); setLabel(); };
      mark();
      if (qs.length > 1) parts.push(h('div.eyebrow', 'Качество'), grid);
      else setLabel();
    }
    dl.onclick = async () => {
      busy(dl, true);
      try {
        await post('/api/links/download', { id: r.id, height: chosen?.height, kind });
        s.close();
        toast(isAudio ? 'Трек добавлен в загрузку' : 'Загрузка началась — карточка уже в библиотеке');
      } catch (e) {
        busy(dl, false);
        result.append(alertBox(e.message));
      }
    };
    parts.push(dl);
    result.replaceChildren(...parts);
  }

  const form = h('form.linkrow', { onsubmit: (e) => { e.preventDefault(); resolve(input.value); } }, input, go);
  input.addEventListener('paste', () => setTimeout(() => { if (/^https?:\/\/\S+$/i.test(input.value.trim())) resolve(input.value); }, 0));
  const linkPane = [form, result];
  if (!store.ytdlp) linkPane.unshift(alertBox('yt-dlp не установлен на сервере — пока работают только прямые ссылки на файлы. Поставить: npm run setup'));

  // ── Файлы ───────────────────────────────────────────────────────────────
  const fileInput = h('input', { type: 'file', multiple: true, accept: ACCEPT[kind], hidden: true });
  fileInput.addEventListener('change', () => { if (startFiles([...fileInput.files], kind)) s.close(); });
  const zone = h('div.dropzone', { role: 'button', tabIndex: 0, onclick: () => fileInput.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); } },
    icon('upload'),
    h('div', h('b', isAudio ? 'Выбери треки' : 'Выбери файлы'), h('span.muted', ' или перетащи их сюда')),
    h('div.small.faint', isAudio ? 'MP3, FLAC, M4A, OGG, WAV' : 'MP4, MKV, AVI, MOV, WEBM — любого размера. Можно закрыть вкладку: после возвращения загрузка продолжится.'));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('over'); if (startFiles([...e.dataTransfer.files], kind)) s.close(); });

  function draw() {
    pane.replaceChildren(...(tab === 'link' ? linkPane : [zone, fileInput]));
    if (tab === 'link') setTimeout(() => input.focus({ preventScroll: true }), 60);
  }
  draw();
  return s;
}

// ── Лента загрузок файлов ─────────────────────────────────────────────────
export function uploadsTray(kind) {
  const el = h('div.uploads');
  const rows = new Map();
  const picker = h('input', { type: 'file', hidden: true, accept: ACCEPT[kind] });
  picker.addEventListener('change', () => { if (picker.files[0]) uploads.add(picker.files[0], kind); picker.value = ''; });

  function row(key) {
    const name = h('div.name.clip'), info = h('div.info.num'), bar = h('i'), meter = h('div.meter', bar), act = h('div.row', { style: { gap: '4px' } });
    const r = h('div.up', icon('upload', 'ic-s'), h('div.grow', name, info), act, meter);
    Object.assign(r, { _name: name, _info: info, _bar: bar, _meter: meter, _act: act, _key: key, _mode: '' });
    return r;
  }

  function render() {
    const seen = new Set();
    for (const u of uploads.list.filter((x) => x.kind === kind && x.status !== 'cancelled')) {
      const key = `u${u.id}`;
      seen.add(key);
      let r = rows.get(key);
      if (!r) { r = row(key); rows.set(key, r); el.append(r); }
      r._name.textContent = u.name;
      r._bar.style.width = `${u.progress}%`;
      r._meter.classList.toggle('busy', u.status === 'starting' || u.status === 'finishing');
      const pct = `${Math.floor(u.progress)}%`;
      r._info.textContent = u.status === 'error' ? u.error
        : u.status === 'starting' ? 'Подготовка…'
          : u.status === 'finishing' ? 'Проверяю файл…'
            : u.status === 'waiting' ? `${pct} · нет связи — жду и продолжу сама`
              : [pct, `${fmtBytes(u.bytes)} из ${fmtBytes(u.size)}`, fmtSpeed(u.speed), fmtEta(u.eta)].filter(Boolean).join(' · ');
      const mode = u.status === 'error' ? 'error' : 'run';
      if (r._mode !== mode) {
        r._mode = mode;
        r._act.replaceChildren(...kids(
          mode === 'error' ? h('button.btn.btn-s', { type: 'button', onclick: () => { uploads.remove(u); uploads.add(u.file, kind); } }, 'Повторить') : null,
          h('button.btn.btn-ghost.btn-icon.btn-s', { type: 'button', title: 'Отменить', onclick: () => (u.status === 'error' ? uploads.remove(u) : u.cancel()) }, icon('x', 'ic-s'))));
      }
    }
    for (const p of uploads.pending.filter((x) => x.kind === kind)) {
      const key = `p${p.id}`;
      seen.add(key);
      let r = rows.get(key);
      if (!r) {
        r = row(key);
        rows.set(key, r);
        el.append(r);
        r._act.replaceChildren(
          h('button.btn.btn-s', { type: 'button', onclick: () => picker.click() }, 'Выбрать файл'),
          h('button.btn.btn-ghost.btn-icon.btn-s', { type: 'button', title: 'Удалить', onclick: () => uploads.dropPending(p.id) }, icon('x', 'ic-s')));
      }
      const pct = p.total ? Math.floor((p.received / p.total) * 100) : 0;
      r._name.textContent = p.name;
      r._bar.style.width = `${pct}%`;
      r._info.textContent = `Прервана на ${pct}% (${fmtBytes(p.size)}). Выбери этот же файл — докачаю с того же места`;
    }
    for (const [key, r] of rows) if (!seen.has(key)) { r.remove(); rows.delete(key); }
  }
  const off = uploads.events.on('change', render);
  el.append(picker);
  render();
  uploads.loadPending();
  el.destroy = off;
  return el;
}

// ── Перетаскивание файлов прямо в окно ────────────────────────────────────
export function enableDrop(defaultKind, allowed) {
  let overlay = null, depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const hide = () => { depth = 0; overlay?.remove(); overlay = null; };
  const onEnter = (e) => {
    if (!hasFiles(e) || document.querySelector('.sheet-wrap')) return;
    depth++;
    if (!overlay) {
      overlay = h('div.drop', h('div.drop-box', icon('upload'), h('div.h2', 'Отпусти, чтобы загрузить'), h('div.muted', defaultKind === 'audio' ? 'Треки попадут в музыку' : 'Видео попадёт в библиотеку, музыка — в треки')));
      document.body.append(overlay);
    }
  };
  const onOver = (e) => { if (hasFiles(e)) e.preventDefault(); };
  const onLeave = (e) => { if (!hasFiles(e)) return; if (--depth <= 0) hide(); };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    if (document.querySelector('.sheet-wrap')) return;
    const byKind = { video: [], audio: [] };
    for (const f of e.dataTransfer.files) {
      const k = f.type.startsWith('audio/') || AUDIO_EXT.test(f.name) ? 'audio' : f.type.startsWith('video/') || !f.type ? 'video' : defaultKind;
      byKind[k].push(f);
    }
    for (const k of ['video', 'audio']) {
      if (!byKind[k].length) continue;
      if (!allowed(k)) { toast(k === 'video' ? 'Фильмы загружает только владелец' : 'Добавление музыки отключено владельцем'); continue; }
      startFiles(byKind[k], k);
    }
  };
  addEventListener('dragenter', onEnter);
  addEventListener('dragover', onOver);
  addEventListener('dragleave', onLeave);
  addEventListener('drop', onDrop);
  return () => {
    hide();
    removeEventListener('dragenter', onEnter);
    removeEventListener('dragover', onOver);
    removeEventListener('dragleave', onLeave);
    removeEventListener('drop', onDrop);
  };
}
