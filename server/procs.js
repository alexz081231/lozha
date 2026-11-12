// Запуск внешних программ: группы процессов, отмена по ключу (id фильма), построчный вывод.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';

const isWin = process.platform === 'win32';
const all = new Set();
const byKey = new Map(); // key → Set<child>
const aborts = new Map(); // key → Set<AbortController>
const cancelled = new Set();

export function killTree(child, sig = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.killed && sig !== 'SIGKILL') { /* всё равно пробуем ниже */ }
  try {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, sig);
  } catch {
    try { child.kill(sig); } catch {}
  }
}

// Список запущенных процессов лежит на диске: если сервер упадёт, при следующем старте добьём «сирот».
const PIDS = path.join(DATA, 'children.json');
function savePids() {
  try { fs.writeFileSync(PIDS, JSON.stringify([...all].map((c) => c.pid).filter(Boolean))); } catch {}
}

export function reapOrphans() {
  let pids = [];
  try { pids = JSON.parse(fs.readFileSync(PIDS, 'utf8')); } catch {}
  let n = 0;
  for (const pid of Array.isArray(pids) ? pids : []) {
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try {
      if (isWin) {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
        if (!/yt-dlp|ffmpeg|ffprobe/i.test(out)) continue;
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
        if (!/yt-dlp|ffmpeg|ffprobe/i.test(cmd)) continue; // pid уже занят чем-то чужим — не трогаем
        try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
      }
      n++;
    } catch {}
  }
  try { fs.rmSync(PIDS, { force: true }); } catch {}
  return n;
}

function register(key, child) {
  all.add(child);
  savePids();
  if (key) {
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(child);
  }
  child.once('close', () => {
    all.delete(child);
    savePids();
    const s = key && byKey.get(key);
    if (s) { s.delete(child); if (!s.size) byKey.delete(key); }
  });
}

function start(key, cmd, args, opts = {}) {
  // Отменённая задача не должна запускать новые процессы (отмена могла прийти между шагами).
  if (key && cancelled.has(key)) throw Object.assign(new Error('отменено'), { code: 'ECANCELLED' });
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.env || process.env,
    cwd: opts.cwd,
    windowsHide: true,
    detached: !isWin, // своя группа процессов: убиваем вместе с дочерними (ffmpeg у yt-dlp и т. п.)
  });
  register(key, child);
  return child;
}

// Короткий запуск с накоплением вывода.
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = start(opts.key, cmd, args, opts); } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e), timedOut: false, error: e });
    }
    let out = '', err = '', timedOut = false;
    const cap = opts.maxBuffer || 96 * 1024 * 1024;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (out.length < cap) out += d; });
    child.stderr.on('data', (d) => { err += d; if (err.length > 400000) err = err.slice(-200000); });
    const timer = opts.timeout ? setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGKILL');
    }, opts.timeout) : null;
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: err + String(e), timedOut, error: e }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err, timedOut }); });
  });
}

// Долгий запуск: вывод построчно, сторож на «тишину».
export function runLines(key, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = start(key, cmd, args, opts); } catch (e) {
      return resolve({ code: -1, tail: String(e), stalled: false, cancelled: e.code === 'ECANCELLED' });
    }
    const tail = [];
    let last = Date.now(), stalled = false;
    const feed = (stream, cb, keep) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => {
        last = Date.now();
        buf += d;
        const parts = buf.split(/\r\n|\n|\r/);
        buf = parts.pop();
        for (const line of parts) {
          if (keep && line.trim()) { tail.push(line); if (tail.length > 60) tail.shift(); }
          try { cb?.(line, child); } catch {}
        }
      });
      stream.on('end', () => { if (buf) { if (keep && buf.trim()) tail.push(buf); try { cb?.(buf, child); } catch {} } });
    };
    feed(child.stdout, opts.onOut, false);
    feed(child.stderr, opts.onErr, true);
    const watch = opts.stallMs ? setInterval(() => {
      if (Date.now() - last > opts.stallMs) { stalled = true; killTree(child, 'SIGKILL'); }
    }, 5000) : null;
    child.on('error', (e) => { clearInterval(watch); resolve({ code: -1, tail: String(e), stalled }); });
    child.on('close', (code, signal) => { clearInterval(watch); resolve({ code, signal, tail: tail.join('\n'), stalled }); });
  });
}

export function trackAbort(key) {
  const ac = new AbortController();
  if (cancelled.has(key)) ac.abort();
  if (!aborts.has(key)) aborts.set(key, new Set());
  aborts.get(key).add(ac);
  return { signal: ac.signal, done: () => { const s = aborts.get(key); if (s) { s.delete(ac); if (!s.size) aborts.delete(key); } } };
}

// Отмена всего, что запущено для ключа.
export function cancelKey(key) {
  cancelled.add(key);
  setTimeout(() => cancelled.delete(key), 15 * 60000).unref();
  for (const ac of aborts.get(key) || []) { try { ac.abort(); } catch {} }
  const set = byKey.get(key);
  if (set) {
    for (const child of [...set]) {
      killTree(child, 'SIGTERM');
      setTimeout(() => { if (child.exitCode === null) killTree(child, 'SIGKILL'); }, 2500);
    }
  }
}
export const isCancelled = (key) => cancelled.has(key);
export const uncancel = (key) => cancelled.delete(key);
export const hasProcs = (key) => byKey.has(key);

export function killAllChildren() {
  for (const child of all) killTree(child, 'SIGKILL');
}
