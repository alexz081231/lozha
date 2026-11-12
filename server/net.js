// Сеть с защитой от SSRF: ни один наш запрос не уходит во внутреннюю сеть,
// адрес проверяется в момент соединения и заново на каждом редиректе.
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs';
import { UA } from './config.js';
import { bad, sleep } from './util.js';

const block = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['224.0.0.0', 3],
]) block.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) block.addSubnet(a, p, 'ipv6');

export class BlockedError extends Error {
  constructor(message = 'адрес во внутренней сети') {
    super(message);
    this.code = 'EBLOCKED';
  }
}

export function isInternalIp(ipRaw) {
  const ip = String(ipRaw).replace(/%.*$/, '');
  const fam = net.isIP(ip);
  if (fam === 4) return block.check(ip, 'ipv4');
  if (fam === 6) {
    const low = ip.toLowerCase();
    // IPv4 внутри IPv6 (mapped / NAT64) — проверяем вложенный адрес.
    let m = low.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return block.check(m[1], 'ipv4');
    m = low.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (m) {
      const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
      return block.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
    }
    return block.check(ip, 'ipv6');
  }
  return true;
}

const INTERNAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|corp|localdomain)$/i;

export async function lookupPublic(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isInternalIp(host)) throw new BlockedError();
    return [{ address: host, family: net.isIP(host) }];
  }
  if (INTERNAL_NAME.test(host)) throw new BlockedError();
  const list = await dns.promises.lookup(host, { all: true });
  const ok = list.filter((a) => !isInternalIp(a.address));
  if (!ok.length) throw new BlockedError();
  return ok;
}

// Проверка ссылки перед тем, как отдать её yt-dlp/ffmpeg.
export async function assertPublicUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw bad('Это не похоже на ссылку'); }
  if (!/^https?:$/.test(url.protocol)) throw bad('Подходят только ссылки http:// и https://');
  try {
    await lookupPublic(url.hostname);
  } catch (e) {
    if (e.code === 'EBLOCKED') throw bad('Эта ссылка ведёт во внутреннюю сеть — такие адреса запрещены');
    // Ошибку DNS покажет сам загрузчик — здесь не решаем за него.
  }
  return url;
}

function guardedLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  if (INTERNAL_NAME.test(hostname)) return cb(new BlockedError());
  dns.lookup(hostname, { family: options.family || 0, hints: options.hints, all: true }, (err, list) => {
    if (err) return cb(err);
    const ok = list.filter((a) => !isInternalIp(a.address));
    if (!ok.length) return cb(new BlockedError());
    if (options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 12 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 12 }),
};

function requestOnce(url, { method = 'GET', headers = {}, timeout = 30000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isInternalIp(host)) return reject(new BlockedError());
    if (INTERNAL_NAME.test(host)) return reject(new BlockedError());
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method, headers, lookup: guardedLookup, signal, agent: agents[url.protocol] }, (res) => resolve({ req, res }));
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('сайт не отвечает'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

// GET/HEAD с ручными редиректами: каждый следующий адрес проходит ту же проверку.
export async function safeFetch(start, opts = {}) {
  let url = typeof start === 'string' ? new URL(start) : start;
  const chain = [];
  const max = opts.maxRedirects ?? 8;
  for (let hop = 0; hop <= max; hop++) {
    if (!/^https?:$/.test(url.protocol)) throw new BlockedError('недопустимый протокол');
    const headers = { 'user-agent': UA, accept: '*/*', 'accept-language': 'ru,en;q=0.8', ...opts.headers };
    const { req, res } = await requestOnce(url, { ...opts, headers });
    chain.push(url.href);
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url);
      continue;
    }
    return { req, res, url, chain, status: res.statusCode, headers: res.headers };
  }
  throw new Error('слишком много перенаправлений');
}

function decodeStream(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

export async function readText(r, maxBytes = 3_000_000) {
  const stream = decodeStream(r.res);
  const chunks = [];
  let n = 0;
  await new Promise((resolve, reject) => {
    const fin = () => resolve();
    stream.on('data', (c) => {
      n += c.length;
      chunks.push(c);
      if (n >= maxBytes) { r.res.destroy(); fin(); }
    });
    stream.on('end', fin);
    stream.on('close', fin);
    stream.on('error', (e) => (n ? fin() : reject(e)));
    r.res.on('error', (e) => (n ? fin() : reject(e)));
  });
  const buf = Buffer.concat(chunks);
  const head = buf.subarray(0, 4096).toString('latin1');
  const charset = /charset=["']?([\w-]+)/i.exec(String(r.headers['content-type'] || ''))?.[1]
    || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(buf); } catch { return buf.toString('utf8'); }
}

export async function fetchText(u, { maxBytes, timeout = 20000, headers } = {}) {
  const r = await safeFetch(u, {
    timeout,
    headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-encoding': 'gzip, deflate, br', ...headers },
  });
  const text = await readText(r, maxBytes);
  return { text, url: r.url, status: r.status, headers: r.headers };
}

// Потоковое скачивание файла с докачкой и проверкой каждого редиректа.
export async function downloadToFile(u, dest, { onProgress, signal, headers = {}, maxBytes = Infinity, stallMs = 45000 } = {}) {
  let received = 0, total = 0, type = '';
  const fh = await fs.promises.open(dest, 'w');
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const h = { ...headers, 'accept-encoding': 'identity' };
        if (received > 0) h.range = `bytes=${received}-`;
        const r = await safeFetch(u, { headers: h, timeout: stallMs, signal });
        if (r.status >= 400) {
          r.res.resume();
          const e = new Error(`сайт ответил ошибкой ${r.status}`);
          e.httpStatus = r.status;
          e.fatal = r.status !== 408 && r.status !== 429 && r.status < 500;
          throw e;
        }
        if (received > 0 && r.status !== 206) { received = 0; await fh.truncate(0); }
        type = String(r.headers['content-type'] || type);
        const cr = /\/(\d+)\s*$/.exec(String(r.headers['content-range'] || ''));
        const len = Number(r.headers['content-length']) || 0;
        total = cr ? Number(cr[1]) : (len ? len + (r.status === 206 ? received : 0) : total);
        if (total > maxBytes) {
          r.res.destroy();
          throw Object.assign(new Error('не хватает места на диске'), { fatal: true, code: 'ENOSPC' });
        }
        for await (const chunk of r.res) {
          await fh.write(chunk, 0, chunk.length, received);
          received += chunk.length;
          if (received > maxBytes) throw Object.assign(new Error('не хватает места на диске'), { fatal: true, code: 'ENOSPC' });
          onProgress?.(received, total);
        }
        if (total && received < total) throw new Error('соединение оборвалось');
        return { size: received, type };
      } catch (e) {
        if (signal?.aborted || e.fatal || e.code === 'EBLOCKED' || attempt >= 6) throw e;
        await sleep(1200 * attempt);
      }
    }
  } finally {
    await fh.close().catch(() => {});
  }
}
