import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC = path.join(ROOT, 'public');
export const DATA = path.resolve(process.env.LOZHA_DATA || path.join(ROOT, 'data'));
export const DIRS = {
  media: path.join(DATA, 'media'),
  tmp: path.join(DATA, 'tmp'),
  uploads: path.join(DATA, 'uploads'),
  avatars: path.join(DATA, 'avatars'),
  certs: path.join(DATA, 'certs'),
};
for (const d of [DATA, ...Object.values(DIRS)]) fs.mkdirSync(d, { recursive: true });

// Папка для своих программ (yt-dlp, при желании ffmpeg). На сервере с песочницей её удобно вынести к данным.
export const BIN = path.resolve(process.env.LOZHA_BIN || path.join(ROOT, 'bin'));

export const APP_NAME = 'Ложа';
export const PORT = Number(process.env.PORT) || 3000;
export const HOST = process.env.HOST || '0.0.0.0';
// За обратным прокси (nginx): верим заголовкам X-Forwarded-Proto и X-Real-IP.
export const TRUST_PROXY = process.env.LOZHA_TRUST_PROXY === '1';
// Отдача файлов через nginx (X-Accel-Redirect), например LOZHA_ACCEL=/_media/
export const ACCEL = process.env.LOZHA_ACCEL || '';
export const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
export const USE_HTTPS = process.argv.includes('--https') || process.env.LOZHA_HTTPS === '1';

// Владелец создаётся при первом запуске. Пароль смени сразу после входа («Настройки» → «Профиль»).
export const OWNER_LOGIN = process.env.LOZHA_OWNER || 'Пользователь';
export const OWNER_PASSWORD = process.env.LOZHA_OWNER_PASSWORD || '12345678';

export const CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_DOWNLOADS = 3;
export const INVITE_TTL = 7 * 24 * 3600 * 1000;
export const SESSION_TTL = 30 * 24 * 3600 * 1000;
export const COOKIES_FILE = path.join(DATA, 'cookies.txt');

// Свой User-Agent для запросов к сайтам (и для yt-dlp).
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// Только для автопроверки: если задан, включает /dev/login и приём отчётов плеера.
export const DEV_TOKEN = process.env.LOZHA_DEV_TOKEN || '';

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  // Сначала обычные домашние сети — их адрес почти наверняка нужный.
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return out.sort((x, y) => rank(x) - rank(y));
}
