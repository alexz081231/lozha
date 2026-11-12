// Загрузка файлов кусками: параллельно, с докачкой после обрыва и перезагрузки страницы.
import fs from 'node:fs';
import path from 'node:path';
import { sql } from './db.js';
import { DIRS, DATA, CHUNK_SIZE } from './config.js';
import { bad, rid, freeBytes, fmtBytes, titleFromName } from './util.js';
import { createMedia, mediaDir } from './library.js';

const open = new Map(); // id → { bitmap, count, total, fh, lastUse }
const partPath = (id) => path.join(DIRS.uploads, `${id}.part`);
const chunkCount = (row) => Math.max(1, Math.ceil(row.size / row.chunk_size));

function state(row) {
  let st = open.get(row.id);
  if (!st) {
    const total = chunkCount(row);
    const bitmap = Buffer.alloc(Math.ceil(total / 8));
    if (row.chunks) Buffer.from(row.chunks).copy(bitmap);
    let count = 0;
    for (let i = 0; i < total; i++) if (bitmap[i >> 3] & (1 << (i & 7))) count++;
    st = { bitmap, count, total, fhp: null, lastUse: Date.now() };
    open.set(row.id, st);
  }
  st.lastUse = Date.now();
  return st;
}
const received = (st) => {
  const out = [];
  for (let i = 0; i < st.total; i++) if (st.bitmap[i >> 3] & (1 << (i & 7))) out.push(i);
  return out;
};

function getRow(user, id) {
  const row = sql('SELECT * FROM uploads WHERE id = ?').get(id);
  if (!row || row.user_id !== user.id) throw bad('Загрузка не найдена', 404);
  return row;
}

export function listUploads(user) {
  return sql('SELECT * FROM uploads WHERE user_id = ? ORDER BY created_at').all(user.id).map((row) => {
    const st = state(row);
    return { id: row.id, name: row.name, size: row.size, mtime: row.mtime, kind: row.kind, chunkSize: row.chunk_size, received: st.count, total: st.total };
  });
}

export async function beginUpload(user, body) {
  const name = String(body.name || '').replace(/[\\/\0]/g, '_').trim().slice(0, 240);
  const size = Number(body.size);
  const mtime = Math.floor(Number(body.mtime) || 0);
  const kind = body.kind === 'audio' ? 'audio' : 'video';
  if (!name) throw bad('У файла нет имени');
  if (!Number.isSafeInteger(size) || size <= 0) throw bad('Пустой файл');

  // Тот же файл уже начинали загружать — продолжаем.
  const old = sql('SELECT * FROM uploads WHERE user_id = ? AND name = ? AND size = ? AND mtime = ? AND kind = ?').get(user.id, name, size, mtime, kind);
  if (old && fs.existsSync(partPath(old.id))) {
    const st = state(old);
    return { id: old.id, chunkSize: old.chunk_size, total: st.total, received: received(st), resumed: st.count > 0 };
  }
  if (old) sql('DELETE FROM uploads WHERE id = ?').run(old.id);

  const free = await freeBytes(DATA);
  if (free < size * 2.1 + 200e6) throw bad(`Не хватает места на диске: файл ${fmtBytes(size)}, свободно ${fmtBytes(free)}`, 507);

  const id = rid(9);
  const fh = await fs.promises.open(partPath(id), 'w');
  try { await fh.truncate(size); } finally { await fh.close(); }
  const now = Date.now();
  sql('INSERT INTO uploads (id, user_id, kind, name, size, mtime, chunk_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, user.id, kind, name, size, mtime, CHUNK_SIZE, now, now);
  const row = sql('SELECT * FROM uploads WHERE id = ?').get(id);
  const st = state(row);
  return { id, chunkSize: CHUNK_SIZE, total: st.total, received: [], resumed: false };
}

export async function writeChunk(user, id, index, req) {
  const row = getRow(user, id);
  const st = state(row);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= st.total) throw bad('Нет такого куска');
  const expected = i === st.total - 1 ? row.size - i * row.chunk_size : row.chunk_size;
  if (Number(req.headers['content-length']) !== expected) throw bad('Неверный размер куска');
  // Куски приходят параллельно — файл открываем один раз на всех.
  st.fhp ||= fs.promises.open(partPath(id), 'r+');
  const fh = await st.fhp;
  let off = i * row.chunk_size, got = 0;
  for await (const chunk of req) {
    got += chunk.length;
    if (got > expected) throw bad('Кусок больше ожидаемого');
    await fh.write(chunk, 0, chunk.length, off);
    off += chunk.length;
  }
  if (got !== expected) throw bad('Кусок получен не полностью');
  if (!(st.bitmap[i >> 3] & (1 << (i & 7)))) {
    st.bitmap[i >> 3] |= 1 << (i & 7);
    st.count++;
  }
  st.lastUse = Date.now();
  sql('UPDATE uploads SET chunks = ?, updated_at = ? WHERE id = ?').run(st.bitmap, Date.now(), id);
  return { received: st.count, total: st.total };
}

async function closeState(id) {
  const st = open.get(id);
  open.delete(id);
  if (st?.fhp) { try { await (await st.fhp).close(); } catch {} }
}

export async function completeUpload(user, id) {
  const row = getRow(user, id);
  const st = state(row);
  if (st.count < st.total) {
    const have = new Set(received(st));
    const missing = [];
    for (let i = 0; i < st.total && missing.length < 200; i++) if (!have.has(i)) missing.push(i);
    throw bad('Файл загружен не полностью', 409, { missing });
  }
  await closeState(id);
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(row.name)?.[1] || 'bin').toLowerCase();
  const mediaId = createMedia({
    kind: row.kind, title: titleFromName(row.name), status: 'processing', stage: 'Обрабатывается', origin: 'upload', addedBy: user.id,
  });
  await fs.promises.rename(partPath(id), path.join(mediaDir(mediaId), `orig.${ext}`));
  sql('DELETE FROM uploads WHERE id = ?').run(id);
  return mediaId;
}

export async function cancelUpload(user, id) {
  const row = getRow(user, id);
  await closeState(row.id);
  sql('DELETE FROM uploads WHERE id = ?').run(row.id);
  await fs.promises.rm(partPath(row.id), { force: true }).catch(() => {});
}

// Закрываем простаивающие файлы; раз в сутки убираем брошенные загрузки.
setInterval(() => {
  const now = Date.now();
  for (const [id, st] of open) if (now - st.lastUse > 120e3) closeState(id);
}, 60e3).unref();

export async function cleanupUploads() {
  const old = Date.now() - 7 * 24 * 3600e3;
  for (const row of sql('SELECT id FROM uploads WHERE updated_at < ?').all(old)) {
    sql('DELETE FROM uploads WHERE id = ?').run(row.id);
    await fs.promises.rm(partPath(row.id), { force: true }).catch(() => {});
  }
  const known = new Set(sql('SELECT id FROM uploads').all().map((r) => `${r.id}.part`));
  try {
    for (const n of await fs.promises.readdir(DIRS.uploads)) if (!known.has(n)) await fs.promises.rm(path.join(DIRS.uploads, n), { force: true });
  } catch {}
}
