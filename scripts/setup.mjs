#!/usr/bin/env node
// Ставит официальный yt-dlp в ./bin, если его нет в системе.
// Запускается после `npm install` и вручную: `npm run setup` (с --force — перекачать заново).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { installYtdlp, ytdlpTarget } from './ytdlp-install.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.resolve(process.env.LOZHA_BIN || path.join(ROOT, 'bin'));
const quiet = process.argv.includes('--quiet');
const force = process.argv.includes('--force');
const isWin = process.platform === 'win32';
const say = (...a) => console.log('[ложа]', ...a);

function inPath(name) {
  const exe = isWin ? `${name}.exe` : name;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  if (!isWin) dirs.push('/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'));
  for (const d of dirs) {
    if (!d || path.resolve(d) === BIN) continue;
    const p = path.join(d, exe);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

async function main() {
  const target = ytdlpTarget(BIN);
  const ffmpeg = inPath('ffmpeg') || fs.existsSync(path.join(BIN, isWin ? 'ffmpeg.exe' : 'ffmpeg'));
  if (!ffmpeg) {
    say('ffmpeg не найден — без него сайт не сможет обрабатывать видео. Поставь его:');
    say('  macOS:   brew install ffmpeg');
    say('  Windows: winget install Gyan.FFmpeg');
    say('  Linux:   sudo apt install ffmpeg');
  }

  if (!force && fs.existsSync(target.exe)) { if (!quiet) say(`yt-dlp уже лежит в ${path.relative(ROOT, BIN) || BIN}`); return; }
  const system = inPath('yt-dlp');
  if (!force && system) { if (!quiet) say(`yt-dlp найден в системе: ${system}`); return; }
  await installYtdlp(BIN, { say });
}

main().catch((e) => {
  say(`не получилось поставить yt-dlp автоматически: ${e.message}`);
  say('поставь вручную: brew install yt-dlp  |  winget install yt-dlp  |  pipx install yt-dlp');
  say('или повтори позже: npm run setup');
});
