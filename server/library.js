// Библиотека: записи о фильмах и треках, их публичный вид и рассылка изменений.
import path from 'node:path';
import fs from 'node:fs';
import { sql } from './db.js';
import { DIRS } from './config.js';
import * as hub from './hub.js';
import { rid, rmrf } from './util.js';

export const mediaDir = (id) => path.join(DIRS.media, id);

const live = new Map(); // id → { progress, stage, speed, eta } — не пишем в БД каждую секунду
const liveVariant = new Map(); // variantId → progress
const timers = new Map();

export const getMedia = (id) => sql('SELECT * FROM media WHERE id = ?').get(id) || null;
export const variantsOf = (id) => sql('SELECT * FROM variants WHERE media_id = ? ORDER BY q DESC, id ASC').all(id);
export const getVariant = (id) => sql('SELECT * FROM variants WHERE id = ?').get(id) || null;

export function publicMedia(m) {
  const l = live.get(m.id) || {};
  const out = {
    id: m.id,
    kind: m.kind,
    title: m.title,
    artist: m.artist || '',
    status: m.status,
    progress: Math.round((l.progress ?? m.progress ?? 0) * 10) / 10,
    stage: l.stage ?? m.stage ?? '',
    speed: l.speed || 0,
    eta: l.eta || 0,
    error: m.error || '',
    retryable: !!m.retryable,
    duration: m.duration || 0,
    width: m.width || 0,
    height: m.height || 0,
    fps: m.fps || 0,
    poster: m.poster ? `/media/${m.id}/poster.jpg?v=${m.poster}` : '',
    origin: m.origin || '',
    addedBy: m.added_by || 0,
    createdAt: m.created_at,
  };
  if (m.kind === 'video') {
    out.variants = variantsOf(m.id).map((v) => ({
      id: v.id,
      kind: v.kind,
      q: v.q,
      label: v.label,
      width: v.width || 0,
      height: v.height || 0,
      fps: v.fps || 0,
      codec: v.codec || '',
      codecStr: v.codec_str || '',
      size: v.size,
      bitrate: v.bitrate,
      status: v.status,
      progress: Math.round((liveVariant.get(v.id) ?? v.progress ?? 0) * 10) / 10,
      origin: v.origin || 'local',
      url: v.status === 'ready' ? `/media/${m.id}/${v.file}?v=${v.created_at}` : '',
    }));
    out.subtitles = sql('SELECT * FROM subtitles WHERE media_id = ? ORDER BY id').all(m.id)
      .map((s) => ({ id: s.id, lang: s.lang || '', label: s.label || '', url: `/media/${m.id}/${s.file}` }));
  } else {
    out.url = m.status === 'ready' && m.file ? `/media/${m.id}/${m.file}?v=${m.poster || m.created_at}` : '';
  }
  return out;
}

export function listMedia() {
  return sql('SELECT * FROM media ORDER BY created_at DESC').all().map(publicMedia);
}

function emit(id) {
  const m = getMedia(id);
  if (m) hub.broadcast({ t: 'media', media: publicMedia(m) });
}
// Рассылка с троттлингом: прогресс может обновляться десятки раз в секунду.
export function touch(id, immediate = false) {
  if (immediate) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    return emit(id);
  }
  if (timers.has(id)) return;
  timers.set(id, setTimeout(() => { timers.delete(id); emit(id); }, 400));
}

export function createMedia({ kind, title, artist = null, status, origin, job = null, addedBy = null, stage = '' }) {
  const id = rid(8);
  fs.mkdirSync(mediaDir(id), { recursive: true });
  sql(`INSERT INTO media (id, kind, title, artist, status, stage, origin, job, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, kind, String(title).slice(0, 300), artist, status, stage, origin, job ? JSON.stringify(job) : null, addedBy, Date.now());
  touch(id, true);
  return id;
}

const COLS = new Set(['title', 'artist', 'status', 'progress', 'stage', 'error', 'retryable', 'duration', 'width', 'height',
  'fps', 'vcodec', 'acodec', 'file', 'poster', 'job']);

export function patchMedia(id, patch) {
  const keys = Object.keys(patch).filter((k) => COLS.has(k));
  if (keys.length) {
    const vals = keys.map((k) => {
      const v = patch[k];
      if (v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (k === 'job' && v && typeof v === 'object') return JSON.stringify(v);
      return v;
    });
    sql(`UPDATE media SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
  }
  if ('status' in patch) live.delete(id);
  touch(id, true);
}

// Быстро меняющиеся поля — только в памяти.
export function setLive(id, patch) {
  live.set(id, { ...(live.get(id) || {}), ...patch });
  touch(id);
}

export function setVariantProgress(mediaId, variantId, progress) {
  liveVariant.set(variantId, progress);
  touch(mediaId);
}

export function patchVariant(v, patch) {
  const keys = Object.keys(patch);
  sql(`UPDATE variants SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), v.id);
  if ('status' in patch) liveVariant.delete(v.id);
  touch(v.media_id, true);
}

export async function removeMedia(id) {
  sql('DELETE FROM media WHERE id = ?').run(id);
  live.delete(id);
  clearTimeout(timers.get(id));
  timers.delete(id);
  hub.broadcast({ t: 'media:gone', id });
  await rmrf(mediaDir(id));
  await rmrf(path.join(DIRS.tmp, id));
}
