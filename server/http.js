// Крошечный HTTP-слой: маршруты, JSON, статика, отдача файлов с Range.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PUBLIC } from './config.js';
import { HttpError, bad, log } from './util.js';
import { currentUser, originOk } from './auth.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.vtt': 'text/vtt; charset=utf-8', '.crt': 'application/x-x509-ca-cert',
};
export const mime = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(bad('Слишком большой запрос', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit) {
  const b = await readBody(req, limit);
  if (!b.length) return {};
  try {
    const v = JSON.parse(b.toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch { throw bad('Некорректный запрос'); }
}

const routes = [];
// auth: 'user' (по умолчанию) | 'owner' | false
export function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler, auth: opts.auth === undefined ? 'user' : opts.auth });
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:", "media-src 'self' blob: data:", "connect-src 'self' ws: wss:",
    "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '));
}

// ── Отдача файла с Range (нужно для перемотки) ────────────────────────────
export async function sendFile(req, res, file, { type, cache = 'private, no-cache' } = {}) {
  let st;
  try { st = await fs.promises.stat(file); } catch { throw new HttpError(404, 'Файл не найден'); }
  if (!st.isFile()) throw new HttpError(404, 'Файл не найден');
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers = {
    'content-type': type || mime(file),
    'accept-ranges': 'bytes',
    etag,
    'last-modified': st.mtime.toUTCString(),
    'cache-control': cache,
  };
  const range = req.headers.range;
  if (!range && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  let start = 0, end = st.size - 1, status = 200;
  if (range && st.size > 0 && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') start = Math.max(0, st.size - Number(m[2]));
      else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(Number(m[2]), st.size - 1);
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}`, 'accept-ranges': 'bytes' });
        return res.end();
      }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
    }
  }
  headers['content-length'] = st.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end, highWaterMark: 512 * 1024 });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ── Статика ────────────────────────────────────────────────────────────────
const zipped = new Map(); // путь → { tag, br, gz }
async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'Плохой адрес'); }
  if (rel.includes('\0')) throw new HttpError(400, 'Плохой адрес');
  let file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) throw new HttpError(403, 'Нельзя');
  let st = null;
  try { st = await fs.promises.stat(file); } catch {}
  if (!st || !st.isFile()) {
    if (path.extname(rel)) throw new HttpError(404, 'Не найдено');
    file = path.join(PUBLIC, 'index.html'); // SPA: любой путь без расширения — приложение
    st = await fs.promises.stat(file);
  }
  const type = mime(file);
  const tag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers = { 'content-type': type, etag: tag, 'cache-control': 'no-cache' };
  if (req.headers['if-none-match'] === tag) { res.writeHead(304, headers); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается');

  const textual = /^(text\/|application\/(json|manifest\+json)|image\/svg)/.test(type);
  const accept = String(req.headers['accept-encoding'] || '');
  if (textual && st.size > 600 && /\b(br|gzip)\b/.test(accept)) {
    let z = zipped.get(file);
    if (!z || z.tag !== tag) {
      const raw = await fs.promises.readFile(file);
      z = {
        tag,
        br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }),
        gz: zlib.gzipSync(raw, { level: 6 }),
      };
      zipped.set(file, z);
    }
    const useBr = /\bbr\b/.test(accept);
    const body = useBr ? z.br : z.gz;
    res.writeHead(200, { ...headers, 'content-encoding': useBr ? 'br' : 'gzip', 'content-length': body.length, vary: 'Accept-Encoding' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

const API_PREFIX = /^\/(api|media|avatars|dev)\//;

export async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://local'); } catch { res.writeHead(400); return res.end(); }
  const pathname = url.pathname;
  securityHeaders(res);
  try {
    if (API_PREFIX.test(pathname)) {
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      if (!['GET', 'OPTIONS'].includes(method) && !originOk(req)) throw new HttpError(403, 'Запрос с чужого сайта отклонён');
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; } });
        const user = currentUser(req);
        if (r.auth !== false && !user) throw new HttpError(401, 'Нужно войти');
        if (r.auth === 'owner' && user.role !== 'owner') throw new HttpError(403, 'Это может только владелец');
        return await r.handler({ req, res, url, params, user });
      }
      throw new HttpError(404, 'Не найдено');
    }
    return await serveStatic(req, res, pathname);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) log('ошибка запроса', req.method, pathname, e);
    if (res.headersSent) { res.destroy(); return; }
    const message = e instanceof HttpError ? e.message : 'Внутренняя ошибка сервера';
    if (API_PREFIX.test(pathname)) sendJson(res, status, { error: message, ...(e.extra || {}) });
    else { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(message); }
  }
}
