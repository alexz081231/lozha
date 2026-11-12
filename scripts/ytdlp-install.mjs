// Установка официального yt-dlp в ./bin (используется и `npm run setup`, и сервером для обновления).
// macOS: распакованная сборка (yt-dlp_macos.zip) — однофайловая там запускается по 10–20 секунд.
// Linux/Windows: один файл, который умеет обновлять сам себя (`yt-dlp -U`).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest';
const isWin = process.platform === 'win32';

// bin — папка, куда ставим (обычно ./bin проекта)
export function ytdlpTarget(bin) {
  const a = process.arch;
  if (process.platform === 'darwin') {
    const dir = path.join(bin, 'yt-dlp-macos');
    return { mode: 'dir', asset: 'yt-dlp_macos.zip', dir, exe: path.join(dir, 'yt-dlp_macos') };
  }
  if (isWin) {
    const asset = a === 'arm64' ? 'yt-dlp_arm64.exe' : a === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe';
    return { mode: 'file', asset, exe: path.join(bin, 'yt-dlp.exe') };
  }
  if (process.platform === 'linux') {
    const musl = fs.existsSync('/etc/alpine-release');
    const asset = a === 'x64' ? (musl ? 'yt-dlp_musllinux' : 'yt-dlp_linux')
      : a === 'arm64' ? (musl ? 'yt-dlp_musllinux_aarch64' : 'yt-dlp_linux_aarch64') : null;
    return { mode: 'file', asset, exe: path.join(bin, 'yt-dlp') };
  }
  return { mode: 'file', asset: null, exe: path.join(bin, 'yt-dlp') };
}

async function download(url) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) { // сеть иногда моргает — пробуем до трёх раз
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'lozha-setup' }, signal: AbortSignal.timeout(300000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw last;
}

// Номер последнего выпуска — из адреса, на который перенаправляет GitHub (без API и его лимитов).
export async function latestTag() {
  const res = await fetch(BASE, { redirect: 'manual', headers: { 'user-agent': 'lozha-setup' }, signal: AbortSignal.timeout(20000) });
  const loc = res.headers.get('location') || '';
  const m = /\/releases\/tag\/([^/?#]+)/.exec(loc);
  if (!m) throw new Error('не удалось узнать последнюю версию yt-dlp');
  return decodeURIComponent(m[1]);
}

export async function installYtdlp(bin, { say = () => {} } = {}) {
  const t = ytdlpTarget(bin);
  if (!t.asset) throw new Error('для этой платформы нет готовой сборки yt-dlp');
  fs.mkdirSync(bin, { recursive: true });
  say(`скачиваю официальный yt-dlp (${t.asset}) в ${bin} …`);
  const [data, sums] = await Promise.all([download(`${BASE}/download/${t.asset}`), download(`${BASE}/download/SHA2-256SUMS`)]);
  const want = sums.toString('utf8').split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === t.asset)?.[0];
  const got = crypto.createHash('sha256').update(data).digest('hex');
  if (!want || want.toLowerCase() !== got) throw new Error('контрольная сумма yt-dlp не совпала — файл не сохранён');

  if (t.mode === 'dir') {
    const zip = path.join(bin, '.yt-dlp.zip');
    const fresh = `${t.dir}.new`;
    const old = `${t.dir}.old`;
    fs.rmSync(fresh, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
    fs.writeFileSync(zip, data);
    fs.mkdirSync(fresh, { recursive: true });
    try {
      try { execFileSync('/usr/bin/unzip', ['-q', '-o', zip, '-d', fresh], { stdio: 'ignore' }); }
      catch { execFileSync('/usr/bin/ditto', ['-x', '-k', zip, fresh], { stdio: 'ignore' }); }
    } finally { fs.rmSync(zip, { force: true }); }
    if (!fs.existsSync(path.join(fresh, path.basename(t.exe)))) throw new Error('архив yt-dlp распаковался не так, как ожидалось');
    fs.chmodSync(path.join(fresh, path.basename(t.exe)), 0o755);
    if (fs.existsSync(t.dir)) fs.renameSync(t.dir, old);
    fs.renameSync(fresh, t.dir);
    fs.rmSync(old, { recursive: true, force: true });
    fs.rmSync(path.join(bin, 'yt-dlp'), { force: true }); // старая однофайловая сборка больше не нужна
  } else {
    const tmp = `${t.exe}.download`;
    fs.writeFileSync(tmp, data, { mode: 0o755 });
    fs.renameSync(tmp, t.exe);
  }
  // Первый запуск на macOS проходит проверку системы и длится секунд десять — делаем его сразу.
  let version = '';
  try { version = execFileSync(t.exe, ['--version'], { encoding: 'utf8', timeout: 180000 }).trim(); } catch {}
  say(`готово: yt-dlp ${version || ''} (${(data.length / 1048576).toFixed(1)} МБ, SHA-256 проверена)`);
  return { exe: t.exe, version };
}
