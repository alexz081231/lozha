// Внешние инструменты: ffmpeg, ffprobe, yt-dlp. Поиск, проверка, автообновление yt-dlp.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BIN } from './config.js';
import { run } from './procs.js';
import { log } from './util.js';
import { installYtdlp, latestTag, ytdlpTarget } from '../scripts/ytdlp-install.mjs';

const isWin = process.platform === 'win32';

export const tools = {
  ffmpeg: null,
  ffprobe: null,
  ytdlp: null,
  ytdlpVersion: null,
  flags: { jsRuntimes: false, remoteComponents: false },
  hdrTonemap: false,
  encoder: 'libx264',
  nice: null,
  updating: null,
  lastCheck: 0,
  lastNote: '',
  active: 0, // сколько сейчас запущено yt-dlp
};

function candidates(name) {
  const exe = isWin ? `${name}.exe` : name;
  const list = [];
  const env = process.env[`LOZHA_${name.replace(/-/g, '').toUpperCase()}`];
  if (env) list.push(env);
  if (name === 'yt-dlp') list.push(ytdlpTarget(BIN).exe); // своя сборка из ./bin (на macOS — распакованная)
  list.push(path.join(BIN, exe));
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) list.push(path.join(d, exe));
  if (!isWin) {
    for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), 'bin')]) {
      list.push(path.join(d, exe));
    }
  }
  return list;
}

function findExe(name) {
  for (const c of candidates(name)) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

async function readYtdlpInfo() {
  const v = await run(tools.ytdlp, ['--version'], { timeout: 90000 });
  tools.ytdlpVersion = v.code === 0 ? v.stdout.trim().split('\n').pop() : null;
  const h = await run(tools.ytdlp, ['--help'], { timeout: 90000 });
  tools.flags.jsRuntimes = h.stdout.includes('--js-runtimes');
  tools.flags.remoteComponents = h.stdout.includes('--remote-components');
}

export async function checkTools() {
  tools.ffmpeg = findExe('ffmpeg');
  tools.ffprobe = findExe('ffprobe');
  tools.ytdlp = findExe('yt-dlp');
  if (!isWin) tools.nice = ['/usr/bin/nice', '/bin/nice'].find((p) => fs.existsSync(p)) || null;

  if (tools.ffmpeg) {
    const [f, e] = await Promise.all([
      run(tools.ffmpeg, ['-hide_banner', '-filters'], { timeout: 20000 }),
      run(tools.ffmpeg, ['-hide_banner', '-encoders'], { timeout: 20000 }),
    ]);
    tools.hdrTonemap = /\bzscale\b/.test(f.stdout) && /\btonemap\b/.test(f.stdout);
    tools.encoder = /\blibx264\b/.test(e.stdout) ? 'libx264'
      : /\bh264_videotoolbox\b/.test(e.stdout) ? 'h264_videotoolbox'
        : /\blibopenh264\b/.test(e.stdout) ? 'libopenh264' : 'libx264';
  }
  if (tools.ytdlp) await readYtdlpInfo();

  const missing = [];
  if (!tools.ffmpeg) missing.push('ffmpeg');
  if (!tools.ffprobe) missing.push('ffprobe');
  if (!tools.ytdlp || !tools.ytdlpVersion) missing.push('yt-dlp');
  return missing;
}

export function installHelp(missing) {
  const lines = [];
  const ff = missing.includes('ffmpeg') || missing.includes('ffprobe');
  const yt = missing.includes('yt-dlp');
  if (ff) {
    lines.push('Не найден ffmpeg/ffprobe — без него нельзя обрабатывать видео. Как поставить:');
    lines.push('  macOS:    brew install ffmpeg');
    lines.push('  Windows:  winget install Gyan.FFmpeg');
    lines.push('  Linux:    sudo apt install ffmpeg');
    lines.push('  (или положи готовые файлы ffmpeg и ffprobe в папку ./bin)');
  }
  if (yt) {
    lines.push('Не найден yt-dlp — без него не работает загрузка по ссылке. Как поставить:');
    lines.push('  любая система:  npm run setup      (скачает официальную сборку в ./bin)');
    lines.push('  macOS:          brew install yt-dlp');
    lines.push('  Windows:        winget install yt-dlp.yt-dlp');
    lines.push('  Linux:          pipx install yt-dlp');
  }
  return lines;
}

// Аргументы, общие для любого запуска yt-dlp.
export function ytBase() {
  const a = ['--ignore-config', '--color', 'never'];
  // YouTube требует JS-движок: Node уже есть, передаём точный путь к нему.
  if (tools.flags.jsRuntimes) a.push('--js-runtimes', `node:${process.execPath}`);
  if (tools.flags.remoteComponents) a.push('--remote-components', 'ejs:github');
  if (tools.ffmpeg) a.push('--ffmpeg-location', path.dirname(tools.ffmpeg));
  return a;
}

function pythonOf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    if (!first.startsWith('#!') || !/python/i.test(first)) return null;
    const parts = first.slice(2).trim().split(/\s+/);
    return /(^|\/)env$/.test(parts[0]) ? parts[1] : parts[0];
  } catch { return null; }
}

function reportUpdate(before, how) {
  if (tools.ytdlpVersion && before && tools.ytdlpVersion !== before) log(`yt-dlp обновлён: ${before} → ${tools.ytdlpVersion} (${how})`);
  else if (tools.lastNote) log(`yt-dlp ${tools.ytdlpVersion || '?'}: ${tools.lastNote}`);
  else log(`yt-dlp свежий: ${tools.ytdlpVersion}`);
}

async function doUpdate() {
  const before = tools.ytdlpVersion;

  // Своя распакованная сборка в ./bin (macOS) сама себя не обновляет:
  // сверяем версию с последним выпуском и перекачиваем, если вышла новая.
  const managed = ytdlpTarget(BIN);
  if (managed.mode === 'dir' && path.resolve(tools.ytdlp) === path.resolve(managed.exe)) {
    try {
      const tag = await latestTag();
      if (tag !== before) await installYtdlp(BIN, { say: (t) => log(`yt-dlp: ${t}`) });
      tools.lastNote = '';
    } catch (e) {
      tools.lastNote = `не удалось проверить обновление yt-dlp (${e.message})`;
    }
    await readYtdlpInfo();
    return reportUpdate(before, 'новая сборка в ./bin');
  }

  let r = await run(tools.ytdlp, ['--ignore-config', '-U'], { timeout: 300000 });
  let text = `${r.stdout}\n${r.stderr}`;
  let how = 'yt-dlp -U';

  if (/Use that to update/i.test(text) && /pip|PyPi/i.test(text)) {
    // Установлен через pip — обновляем тем же интерпретатором.
    const py = pythonOf(tools.ytdlp);
    const args = ['-m', 'pip', 'install', '-U', '--disable-pip-version-check', 'yt-dlp[default]'];
    how = `${py || 'python3'} -m pip install -U yt-dlp`;
    r = await run(py || 'python3', args, { timeout: 420000 });
    if (r.code !== 0 && /externally-managed-environment/i.test(r.stderr)) {
      r = await run(py || 'python3', [...args, '--user'], { timeout: 420000 });
    }
    if (r.code !== 0) {
      const pip = await run('pip', ['install', '-U', 'yt-dlp'], { timeout: 420000 });
      if (pip.code === 0) r = pip;
    }
    text = `${r.stdout}\n${r.stderr}`;
    tools.lastNote = r.code !== 0 ? 'pip не смог обновить yt-dlp — обнови вручную: pip install -U yt-dlp' : '';
  } else if (/Use that to update/i.test(text)) {
    // Пакетный менеджер. С Homebrew справимся сами, остальное — подсказка.
    let real = tools.ytdlp;
    try { real = fs.realpathSync(tools.ytdlp); } catch {}
    const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew'].find((p) => fs.existsSync(p));
    if (brew && /Cellar|homebrew|linuxbrew/i.test(real)) {
      how = 'brew upgrade yt-dlp';
      r = await run(brew, ['upgrade', 'yt-dlp'], { timeout: 900000, env: { ...process.env, HOMEBREW_NO_ENV_HINTS: '1' } });
      tools.lastNote = r.code !== 0 ? 'brew не смог обновить yt-dlp — обнови вручную: brew upgrade yt-dlp' : '';
    } else {
      tools.lastNote = 'yt-dlp поставлен пакетным менеджером — обновляй им же (или поставь свежий: npm run setup -- --force)';
    }
  } else if (/Re-download the latest release/i.test(text)) {
    tools.lastNote = 'эта сборка yt-dlp не обновляется сама — поставь свежую: npm run setup -- --force';
  } else if (r.code !== 0) {
    const reason = (text.match(/ERROR:.*$/m) || [''])[0].slice(0, 200);
    tools.lastNote = `не удалось проверить обновление yt-dlp${reason ? ` (${reason})` : ''}`;
  } else {
    tools.lastNote = '';
  }

  await readYtdlpInfo();
  reportUpdate(before, how);
}

// Проверка обновления. Пока она идёт, новые запуски yt-dlp ждут (см. ytGate).
export function refreshYtdlp({ force = false } = {}) {
  if (!tools.ytdlp) return Promise.resolve();
  if (tools.updating) return tools.updating;
  if (!force && Date.now() - tools.lastCheck < 3 * 3600e3) return Promise.resolve();
  tools.updating = (async () => {
    // Не подменяем программу под работающими загрузками.
    for (let i = 0; i < 120 && tools.active > 0; i++) await new Promise((r) => setTimeout(r, 5000));
    try { await doUpdate(); } catch (e) { log('yt-dlp: обновление не удалось —', e.message); }
    tools.lastCheck = Date.now();
    tools.updating = null;
  })();
  return tools.updating;
}

export async function ytGate() {
  if (tools.updating && tools.active === 0) await tools.updating;
}

export function scheduleYtdlpUpdates() {
  setInterval(() => { refreshYtdlp().catch(() => {}); }, 6 * 3600e3).unref();
}
