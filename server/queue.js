// Очереди: загрузки по ссылке (не больше трёх сразу), приём файлов, фоновые версии качества.
import fs from 'node:fs';
import path from 'node:path';
import { sql } from './db.js';
import { DIRS, MAX_DOWNLOADS } from './config.js';
import {
  getMedia, patchMedia, setLive, removeMedia, mediaDir, variantsOf, getVariant, patchVariant, setVariantProgress, touch,
} from './library.js';
import { ingestVideo, ingestAudio, transcodeVariant, LADDER, qLabel, summarize, probe, origOf } from './media.js';
import { downloadMedia, siteVariantPlan, readInfo, downloadSiteVariant } from './links.js';
import { cancelKey, uncancel } from './procs.js';
import { bad, log, rmrf } from './util.js';

// ── Слоты загрузок ────────────────────────────────────────────────────────
let active = 0;
const waiters = { hi: [], lo: [] };
function acquire(pri) {
  if (active < MAX_DOWNLOADS) { active++; return Promise.resolve(); }
  return new Promise((res) => waiters[pri].push(res));
}
function release() {
  const next = waiters.hi.shift() || waiters.lo.shift();
  if (next) next(); else active--;
}

export function enqueueDownload(id) {
  (async () => {
    await acquire('hi');
    let held = true;
    const free = () => { if (held) { held = false; release(); } };
    try {
      const m = getMedia(id);
      if (!m || m.status !== 'queued') return;
      const job = JSON.parse(m.job);
      uncancel(id);
      patchMedia(id, { status: 'downloading', stage: 'Скачивается', progress: 0, error: null });
      const res = await downloadMedia(m, job, (p) => setLive(id, p));
      if (!getMedia(id)) { await rmrf(path.join(DIRS.tmp, id)); return; }
      const dir = mediaDir(id);
      await fs.promises.mkdir(dir, { recursive: true });
      for (const n of await fs.promises.readdir(dir)) if (/^(orig|thumb)\./.test(n)) await fs.promises.rm(path.join(dir, n), { force: true });
      const ext = path.extname(res.file).slice(1).toLowerCase() || 'bin';
      await fs.promises.rename(res.file, path.join(dir, `orig.${ext}`));
      if (res.info) await fs.promises.rename(res.info, path.join(dir, 'info.json')).catch(() => {});
      if (res.thumb) await fs.promises.rename(res.thumb, path.join(dir, `thumb${path.extname(res.thumb).toLowerCase()}`)).catch(() => {});
      await rmrf(path.join(DIRS.tmp, id));
      free();
      patchMedia(id, { status: 'processing', stage: 'Обрабатывается', progress: 0 });
      enqueueIngest(id);
    } catch (e) {
      if (!getMedia(id) || e.code === 'cancelled') { await rmrf(path.join(DIRS.tmp, id)); return; }
      if (!e.user) log(`[${id}] ошибка загрузки:`, e);
      // Временные файлы оставляем: «Повторить» продолжит с того же места.
      patchMedia(id, { status: 'error', stage: '', error: e.user ? e.message : 'Что-то пошло не так при загрузке', retryable: 1 });
    } finally {
      free();
    }
  })().catch((e) => log('очередь загрузок:', e));
}

// ── Приём (ffprobe → MP4) ─────────────────────────────────────────────────
const ingestQ = [];
let ingesting = 0;
export function enqueueIngest(id) {
  if (!ingestQ.includes(id)) ingestQ.push(id);
  pumpIngest();
}
function pumpIngest() {
  while (ingesting < 2 && ingestQ.length) {
    const id = ingestQ.shift();
    ingesting++;
    runIngest(id).catch((e) => log('приём файла:', e)).finally(() => { ingesting--; pumpIngest(); });
  }
}
async function runIngest(id) {
  const m = getMedia(id);
  if (!m) return;
  uncancel(id);
  const onP = (p) => setLive(id, { progress: p, stage: 'Обрабатывается', speed: 0, eta: 0 });
  try {
    if (m.kind === 'video') {
      const src = await ingestVideo(m, onP);
      log(`[${id}] «${m.title}» готов к просмотру: ${src.video.codec} ${src.video.dispW}×${src.video.dispH} ${Math.round(src.video.fps)} fps`);
      planVariants(id, src);
    } else {
      await ingestAudio(m, onP);
      log(`[${id}] трек «${getMedia(id)?.title}» готов`);
    }
  } catch (e) {
    if (!getMedia(id) || e.code === 'cancelled') return;
    if (!e.user) log(`[${id}] ошибка обработки:`, e);
    patchMedia(id, {
      status: 'error', stage: '', error: e.user ? e.message : 'Не удалось обработать файл',
      retryable: m.job || origOf(id) ? 1 : 0,
    });
  }
}

// ── Версии качества ───────────────────────────────────────────────────────
export function planVariants(id, src) {
  const m = getMedia(id);
  if (!m || m.kind !== 'video' || !src?.video) return;
  // H.264-исходник играют все: нужны только версии ниже. Для VP9/HEVC/AV1 нужна и совместимая того же размера.
  const targets = LADDER.filter((t) => (src.video.codec === 'h264' ? t < src.q * 0.93 : t <= src.q * 1.03));
  if (!targets.length) return;
  const info = m.origin === 'link' ? readInfo(id) : null;
  const site = info ? siteVariantPlan(info, src, targets) : new Map();
  const have = new Set(variantsOf(id).filter((v) => v.kind === 'quality').map((v) => v.q));
  const now = Date.now();
  for (const t of targets) {
    if (have.has(t)) continue;
    const s = site.get(t);
    sql(`INSERT INTO variants (media_id, kind, q, label, fps, codec, file, status, origin, job, created_at)
         VALUES (?, 'quality', ?, ?, ?, 'h264', ?, 'queued', ?, ?, ?)`)
      .run(id, t, qLabel(t, src.video.fps), src.video.fps, `v${t}.mp4`, s ? 'site' : 'local', s ? JSON.stringify(s) : null, now);
  }
  touch(id, true);
  kickVariants();
}

// Сначала лёгкие (до 720p), потом тяжёлые; внутри — по порядку добавления.
function nextVariant(origin) {
  return sql(`SELECT v.* FROM variants v JOIN media m ON m.id = v.media_id
              WHERE v.status = 'queued' AND v.origin = ? AND m.status = 'ready'
              ORDER BY (v.q > 720) ASC, m.created_at ASC, v.q ASC LIMIT 1`).get(origin);
}

async function runVariant(v, origin) {
  const m = getMedia(v.media_id);
  if (!m) return;
  patchVariant(v, { status: 'processing', progress: 0 });
  const onP = (p) => setVariantProgress(m.id, v.id, p);
  try {
    if (origin === 'site') {
      const src = summarize(await probe(path.join(mediaDir(m.id), 'source.mp4')));
      await downloadSiteVariant(m, v, src, onP);
    } else {
      await transcodeVariant(m.id, v, onP);
    }
    log(`[${m.id}] версия ${v.label} готова (${origin === 'site' ? 'взята с сайта' : 'пересжата'})`);
  } catch (e) {
    if (!getMedia(m.id) || !getVariant(v.id)) return; // фильм удалили
    if (origin === 'site') {
      log(`[${m.id}] версия ${v.label} с сайта не подошла (${e.message}) — пересжимаю сама`);
      patchVariant(v, { status: 'queued', origin: 'local', job: null, progress: 0 });
    } else {
      log(`[${m.id}] версия ${v.label} не получилась: ${e.message}`);
      patchVariant(v, { status: 'error', progress: 0 });
    }
  }
}

let localBusy = false, siteBusy = false;
async function pumpLocal() {
  if (localBusy) return;
  localBusy = true;
  try {
    for (let v = nextVariant('local'); v; v = nextVariant('local')) await runVariant(v, 'local');
  } finally { localBusy = false; }
}
async function pumpSite() {
  if (siteBusy) return;
  siteBusy = true;
  try {
    for (let v = nextVariant('site'); v; v = nextVariant('site')) {
      await acquire('lo');
      try { await runVariant(v, 'site'); } finally { release(); }
      pumpLocal(); // если версия с сайта не подошла, она ушла в локальную очередь
    }
  } finally { siteBusy = false; }
}
export function kickVariants() {
  pumpLocal().catch((e) => log('версии:', e));
  pumpSite().catch((e) => log('версии:', e));
}

// ── Отмена, повтор, восстановление после перезапуска ──────────────────────
export async function cancelAndRemove(id) {
  cancelKey(id); // убивает yt-dlp/ffmpeg этого фильма
  await removeMedia(id);
  try {
    for (const n of await fs.promises.readdir(DIRS.tmp)) if (n === id || n.startsWith(`${id}-`)) await rmrf(path.join(DIRS.tmp, n));
  } catch {}
  setTimeout(() => { rmrf(mediaDir(id)); rmrf(path.join(DIRS.tmp, id)); }, 3500); // на случай, если процесс успел что-то дописать
}

export function retry(id) {
  const m = getMedia(id);
  if (!m) throw bad('Не найдено', 404);
  if (m.status !== 'error') throw bad('Повторять нечего');
  if (origOf(id)) {
    patchMedia(id, { status: 'processing', stage: 'Обрабатывается', error: null, progress: 0 });
    enqueueIngest(id);
  } else if (m.job) {
    patchMedia(id, { status: 'queued', stage: 'В очереди', error: null, progress: 0 });
    enqueueDownload(id);
  } else {
    throw bad('Этот файл нужно загрузить заново');
  }
}

export async function recover() {
  // Недокачанное помечаем ошибкой с кнопкой «Повторить».
  for (const m of sql("SELECT id FROM media WHERE status IN ('queued', 'downloading')").all()) {
    patchMedia(m.id, { status: 'error', stage: '', error: 'Сервер перезапускался — загрузка прервалась', retryable: 1 });
  }
  for (const m of sql("SELECT id, job FROM media WHERE status = 'processing'").all()) {
    if (origOf(m.id)) enqueueIngest(m.id);
    else patchMedia(m.id, { status: 'error', stage: '', error: 'Сервер перезапускался — обработка прервалась', retryable: m.job ? 1 : 0 });
  }
  sql("UPDATE variants SET status = 'queued', progress = 0 WHERE status = 'processing'").run();

  // Чистим временное: оставляем только то, что пригодится для «Повторить».
  try {
    for (const n of await fs.promises.readdir(DIRS.tmp)) {
      if (getMedia(n)?.status !== 'error') await rmrf(path.join(DIRS.tmp, n));
    }
    for (const n of await fs.promises.readdir(DIRS.media)) {
      const dir = path.join(DIRS.media, n);
      if (!getMedia(n)) { await rmrf(dir); continue; }
      for (const f of await fs.promises.readdir(dir)) if (/\.tmp(\.|$)/.test(f)) await fs.promises.rm(path.join(dir, f), { force: true });
    }
  } catch {}
  kickVariants();
}
