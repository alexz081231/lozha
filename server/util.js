import crypto from 'node:crypto';
import fs from 'node:fs';

export const rid = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const bad = (message, status = 400, extra) => new HttpError(status, message, extra);

export function log(...a) {
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}]`, ...a);
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function rmrf(p) {
  try { await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

export function tryJson(s, d = null) {
  try { return JSON.parse(s); } catch { return d; }
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${u[i]}`;
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export async function freeBytes(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return Infinity; }
}

export async function dirSize(dir) {
  let total = 0;
  let list;
  try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of list) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) total += await dirSize(p);
    else { try { total += (await fs.promises.stat(p)).size; } catch {} }
  }
  return total;
}

// Имя файла → заголовок: без расширения, подчёркивания и точки → пробелы.
export function titleFromName(name) {
  let t = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  t = t.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, 200) || 'Без названия';
}
