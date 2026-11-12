// Загрузка по ссылке: разбор (yt-dlp → свой разбор HTML), скачивание, готовые H.264-версии с сайта.
import fs from 'node:fs';
import path from 'node:path';
import { tools, ytBase, ytGate, refreshYtdlp } from './tools.js';
import { run, runLines, trackAbort, isCancelled } from './procs.js';
import { assertPublicUrl, lookupPublic, safeFetch, readText, fetchText, downloadToFile } from './net.js';
import { DIRS, DATA, UA, COOKIES_FILE } from './config.js';
import { HttpError, bad, log, rid, rmrf, freeBytes, fmtBytes, titleFromName, sleep } from './util.js';
import { qOf, qLabel, UserError, probe, summarize, finalizeVariant, ffmpegRun } from './media.js';
import { mediaDir } from './library.js';

const KNOWN = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|rutube\.ru|vk\.com|vk\.ru|vkvideo\.ru|ok\.ru|dzen\.ru|vimeo\.com|dailymotion\.com|twitch\.tv|soundcloud\.com|tiktok\.com|instagram\.com|facebook\.com|x\.com|twitter\.com|bilibili\.com|music\.yandex\.ru|coub\.com|bandcamp\.com|mixcloud\.com|smotrim\.ru|1tv\.ru)$/i;
const MEDIA_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|ts|mpg|mpeg|3gp|ogv|mp3|m4a|aac|flac|ogg|oga|opus|wav)$/i;
const PROG = 'ZP|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s|%(progress.fragment_index)s|%(progress.fragment_count)s';
const NET_ARGS = ['--retries', '10', '--fragment-retries', '20', '--concurrent-fragments', '4', '--socket-timeout', '30'];

// ── Ошибки yt-dlp понятными словами ───────────────────────────────────────
const RULES = [
  [/no space left|errno 28|enospc|larger than max-filesize|disk full|not enough (free )?space/, 'nospace', 'Не хватает места на диске'],
  [/\bdrm\b/, 'drm', 'Видео защищено DRM — такое скачать нельзя'],
  [/confirm you.?re not a bot|not a robot|captcha|unusual traffic/, 'bot', 'Сайт просит подтвердить, что вы не бот. Владелец может загрузить cookies.txt в настройках — с ним получится'],
  [/not available in your country|geo.?restrict|geo.?block|not available from your location|blocked (it )?in your country|not available in your region|недоступно в вашей стране/, 'geo', 'Видео недоступно в стране, где стоит сервер'],
  [/live event will begin|premieres in|this live event|will begin in (a few|\d)|is offline|live stream recording is not available/, 'live', 'Это трансляция или премьера — скачать можно будет после её окончания'],
  [/sign in|log ?in|logged in|login required|authenticat|members?-only|registered users|private video|this video is private|age.?restricted|confirm your age|--cookies/, 'login', 'Сайт требует войти в аккаунт. Владелец может загрузить cookies.txt в настройках — сервер передаст его yt-dlp'],
  [/http error 429|too many requests|rate.?limit/, 'rate', 'Сайт ограничил частоту запросов — попробуй позже'],
  [/video (is )?unavailable|video is not available|has been removed|been deleted|no longer available|removed by the uploader|has been terminated|does not exist|http error 404|http error 410|video not found|page not found|unable to find video|видео удалено/, 'gone', 'Видео удалено или недоступно'],
  [/http error 403|forbidden|access denied/, 'forbidden', 'Сайт отказал в доступе (403)'],
  [/unsupported url/, 'unsupported', 'Этот сайт не поддерживается'],
  [/timed out|timeout/, 'timeout', 'Сайт слишком долго не отвечает'],
  [/unable to download webpage|name or service not known|nodename nor servname|failed to resolve|temporary failure in name resolution|connection (refused|reset|aborted)|network is unreachable|getaddrinfo|remote end closed|ssl|certificate|transporterror|incompleteread/, 'network', 'Не удалось соединиться с сайтом'],
  [/no video formats found|requested format is not available|unable to extract|no video could be found|no media found|failed to (parse|extract)/, 'extract', 'Не получилось найти видео на этой странице'],
];

export function explain(stderr, { timedOut = false } = {}) {
  if (timedOut) return new UserError('Сайт слишком долго не отвечает', 'timeout');
  const all = String(stderr || '');
  const errLines = all.split('\n').map((l) => l.trim()).filter((l) => /^ERROR:/.test(l));
  const text = (errLines.length ? errLines.join('\n') : all.slice(-3000)).toLowerCase();
  for (const [re, code, msg] of RULES) if (re.test(text)) return new UserError(msg, code);
  const last = (errLines.pop() || '').replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*\S+:\s*/, '').slice(0, 200);
  return new UserError(last ? `Не получилось скачать: ${last}` : 'Не получилось скачать видео', 'unknown');
}

function logTail(what, text) {
  const lines = String(text || '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-8);
  if (lines.length) log(`${what}\n    ${lines.join('\n    ')}`);
}

const toHttp = (e) => {
  if (e instanceof HttpError) return e;
  if (e?.user) return new HttpError(422, e.message, { code: e.code });
  log('ошибка разбора ссылки:', e);
  return new HttpError(500, 'Не получилось разобрать ссылку');
};

// ── Вспомогательное ───────────────────────────────────────────────────────
function normalizeUrl(raw) {
  let s = String(raw || '').trim().replace(/^<|>$/g, '');
  if (!s) throw bad('Вставь ссылку');
  if (s.length > 2500) throw bad('Слишком длинная ссылка');
  const m = /https?:\/\/[^\s<>"']+/i.exec(s);
  if (m) s = m[0];
  else if (/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(s)) s = `https://${s}`;
  else throw bad('Это не похоже на ссылку');
  try { return new URL(s).href; } catch { throw bad('Это не похоже на ссылку'); }
}

async function cookieArgs(dir) {
  try { await fs.promises.access(COOKIES_FILE); } catch { return []; }
  const dst = path.join(dir, 'cookies.txt');
  await fs.promises.copyFile(COOKIES_FILE, dst);
  return ['--cookies', dst];
}

const cmp = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
};
const sizeOf = (f, dur) => f?.filesize || f?.filesize_approx || (f?.tbr && dur ? Math.round(f.tbr * 125 * dur) : 0);
const isAudioOnly = (f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none';
const isDrc = (f) => /-drc/i.test(f.format_id || '') || /\bdrc\b/i.test(f.format_note || '');
const isDub = (f) => /dubbed|descriptive/i.test(f.format_note || '');

// Как выберет звук сам yt-dlp при -S "…,acodec:m4a".
function pickBestAudio(formats, dur) {
  const aud = formats.filter((f) => isAudioOnly(f) && !f.has_drm);
  const score = (f) => [/^mp4a/.test(f.acodec) ? 1 : 0, f.language_preference ?? -1, f.quality ?? 0, f.audio_channels || 0, sizeOf(f, dur), f.tbr || 0];
  return aud.sort((a, b) => cmp(score(b), score(a)))[0] || null;
}
// Для готовых версий с сайта: AAC, оригинальная дорожка, не автодубляж и не «-drc».
function pickAacAudio(formats) {
  const aud = formats.filter((f) => isAudioOnly(f) && /^mp4a/.test(f.acodec) && !f.has_drm && !isDrc(f) && !isDub(f));
  if (!aud.length) return null;
  const maxLang = Math.max(...aud.map((f) => f.language_preference ?? -1));
  const orig = aud.filter((f) => (f.language_preference ?? -1) === maxLang);
  const score = (f) => [(f.audio_channels || 2) <= 2 ? 1 : 0, /^mp4a\.40\.2/.test(f.acodec) ? 1 : 0, f.tbr || f.abr || 0];
  return orig.sort((a, b) => cmp(score(b), score(a)))[0];
}

function codecRank(vc) {
  const c = String(vc || '').toLowerCase();
  if (/^(avc|h264)/.test(c)) return 10;
  if (/^vp0?8/.test(c)) return 9;
  if (/^(hev|hvc|h265)/.test(c)) return 6;
  if (/^vp0?9\.0?2|^vp9\.2/.test(c)) return 4;
  if (/^vp0?9/.test(c)) return 5;
  if (/^av0?1/.test(c)) return 3;
  return 1;
}
const shortCodec = (vc) => {
  const c = String(vc || '').toLowerCase();
  return /^(avc|h264)/.test(c) ? 'H.264' : /^vp0?9/.test(c) ? 'VP9' : /^av0?1/.test(c) ? 'AV1' : /^(hev|hvc|h265)/.test(c) ? 'HEVC' : '';
};

// Качества: группируем по высоте, берём максимальный fps, размер = видео + лучший звук.
function buildQualities(info) {
  const dur = info.duration || 0;
  const formats = info.formats || [];
  const vids = formats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.height && f.ext !== 'mhtml' && !f.has_drm);
  const audio = pickBestAudio(formats, dur);
  const byH = new Map();
  for (const f of vids) {
    if (!byH.has(f.height)) byH.set(f.height, []);
    byH.get(f.height).push(f);
  }
  let out = [];
  for (const [h, list] of byH) {
    const maxFps = Math.max(...list.map((f) => f.fps || 0));
    const top = list.filter((f) => (f.fps || 0) >= maxFps - 1);
    const rank = (f) => [codecRank(f.vcodec), sizeOf(f, 0) ? 1 : 0, /^https?$/.test(f.protocol || '') ? 1 : 0, f.tbr || 0];
    const best = top.sort((a, b) => cmp(rank(b), rank(a)))[0];
    const w = best.width || Math.round((h * 16) / 9);
    const q = qOf(w, h);
    const muxed = best.acodec && best.acodec !== 'none';
    out.push({
      height: h,
      q,
      label: qLabel(q, maxFps),
      fps: Math.round(maxFps),
      codec: shortCodec(best.vcodec),
      size: sizeOf(best, dur) + (muxed || !audio ? 0 : sizeOf(audio, dur)),
      approx: !best.filesize,
    });
  }
  out.sort((a, b) => b.height - a.height);
  const seen = new Set();
  out = out.filter((x) => (seen.has(x.label) ? false : seen.add(x.label)));
  if (out.some((x) => x.q >= 360)) out = out.filter((x) => x.q >= 360); // 144p/240p прячем, если есть лучше
  if (!out.length) {
    const best = formats.filter((f) => f.vcodec !== 'none').sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0] || formats[0] || info;
    out = [{ height: 0, q: 0, label: 'Оригинал', fps: 0, codec: shortCodec(best?.vcodec), size: sizeOf(best, dur), approx: true }];
  }
  return out;
}

const bestThumb = (e) => e.thumbnail || (Array.isArray(e.thumbnails) && e.thumbnails.length ? e.thumbnails[e.thumbnails.length - 1].url : '') || '';

// yt-dlp мог уйти по редиректу — проверяем адреса, по которым он собирается качать.
async function checkInfoHosts(info, formats) {
  const hosts = new Set();
  const add = (u) => { try { const x = new URL(u); if (/^https?:$/.test(x.protocol)) hosts.add(x.hostname); } catch {} };
  add(info.webpage_url);
  for (const f of formats) { add(f.url); add(f.manifest_url); if (hosts.size > 14) break; }
  for (const h of hosts) {
    try { await lookupPublic(h); } catch (e) {
      if (e.code === 'EBLOCKED') throw bad('Эта ссылка ведёт во внутреннюю сеть — такие адреса запрещены');
    }
  }
}

// ── yt-dlp -J ─────────────────────────────────────────────────────────────
async function ytJson(url, { referer } = {}) {
  await ytGate();
  const dir = path.join(DIRS.tmp, `r-${rid(6)}`);
  await fs.promises.mkdir(dir, { recursive: true });
  tools.active++;
  try {
    const args = [...ytBase(), '-J', '--no-playlist', '--flat-playlist', '--playlist-end', '40', '--socket-timeout', '30', '--user-agent', UA];
    if (referer) args.push('--referer', referer);
    args.push(...await cookieArgs(dir), '--', url);
    for (let attempt = 1; ; attempt++) {
      const r = await run(tools.ytdlp, args, { timeout: 60000 });
      const out = r.stdout.trim();
      if (r.code === 0 && out.startsWith('{')) {
        try { return JSON.parse(out); } catch {}
      }
      const err = explain(r.stderr, { timedOut: r.timedOut });
      logTail(`yt-dlp не разобрал ${url} (${err.code}):`, r.stderr);
      if ((err.code === 'timeout' || err.code === 'network') && attempt === 1) continue; // один автоповтор
      throw err;
    }
  } finally {
    tools.active--;
    rmrf(dir);
  }
}

async function ytResolve(url, { kind, referer, fallbackTitle, depth = 0 }) {
  const info = await ytJson(url, { referer });
  if (info._type === 'playlist') {
    const entries = (info.entries || []).filter((e) => e && /^https?:/.test(e.url || e.webpage_url || ''));
    if (!entries.length) throw new UserError('Не получилось найти видео на этой странице', 'extract');
    if (entries.length === 1 && depth < 2) {
      return ytResolve(entries[0].url || entries[0].webpage_url, { kind, referer, fallbackTitle, depth: depth + 1 });
    }
    return {
      type: 'list',
      kind,
      title: info.title || fallbackTitle || 'Подборка',
      entries: entries.slice(0, 40).map((e) => ({
        url: e.url || e.webpage_url,
        title: e.title || e.id || 'Без названия',
        duration: e.duration || 0,
        thumbnail: bestThumb(e),
        uploader: e.uploader || e.channel || '',
      })),
    };
  }
  if (info.is_live || ['is_live', 'is_upcoming'].includes(info.live_status)) {
    throw new UserError('Это трансляция или премьера — скачать можно будет после её окончания', 'live');
  }
  const formats = info.formats?.length ? info.formats : (info.url ? [info] : []);
  if (!formats.length) throw new UserError('Не получилось найти видео на этой странице', 'extract');
  if (formats.every((f) => f.has_drm)) throw new UserError('Видео защищено DRM — такое скачать нельзя', 'drm');
  await checkInfoHosts(info, formats);

  const dur = info.duration || 0;
  const sizes = {};
  for (const f of formats) { const s = sizeOf(f, dur); if (f.format_id && s) sizes[f.format_id] = s; }
  const audio = pickBestAudio(formats, dur);
  const anyVideo = formats.some((f) => f.vcodec && f.vcodec !== 'none');
  const title = info.title || fallbackTitle || 'Без названия';
  const page = /^https?:/.test(info.webpage_url || '') ? info.webpage_url : url;
  return {
    type: 'video',
    kind,
    site: info.extractor_key || info.extractor || '',
    title,
    uploader: info.uploader || info.channel || '',
    duration: dur,
    thumbnail: bestThumb(info),
    hasVideo: anyVideo,
    qualities: buildQualities(info),
    audioSize: sizeOf(audio, dur) || sizeOf(formats.slice().sort((a, b) => (a.tbr || 1e9) - (b.tbr || 1e9))[0], dur),
    _job: {
      type: 'ytdlp', url: page, referer: referer || null, sizes, title,
      uploader: info.uploader || info.channel || '', artist: info.artist || info.creator || '', track: info.track || '',
    },
  };
}

// ── Свой разбор: прямой файл, HLS, HTML со встроенным плеером ─────────────
function filenameFrom(disposition) {
  const s = String(disposition || '');
  let m = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(s);
  if (m) { try { return decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch {} }
  m = /filename\s*=\s*"?([^";]+)"?/i.exec(s);
  return m ? m[1].trim() : '';
}

async function preflight(href, referer) {
  const r = await safeFetch(href, {
    timeout: 12000,
    headers: {
      accept: 'text/html,application/xhtml+xml,video/*,audio/*,*/*;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
      ...(referer ? { referer } : {}),
    },
  });
  const type = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const p = r.url.pathname;
  const out = { finalUrl: r.url.href, status: r.status, type, kind: 'other' };
  if (/mpegurl/.test(type) || /\.m3u8$/i.test(p)) { r.res.destroy(); out.kind = 'hls'; return out; }
  if (/dash\+xml/.test(type) || /\.mpd$/i.test(p)) { r.res.destroy(); out.kind = 'dash'; return out; }
  if (r.status < 400 && (/^(video|audio)\//.test(type) || (MEDIA_EXT.test(p) && /octet-stream|binary|^$/.test(type)))) {
    r.res.destroy();
    out.kind = 'file';
    out.size = Number(r.headers['content-length']) || 0;
    let base = '';
    try { base = decodeURIComponent(path.posix.basename(p)); } catch { base = path.posix.basename(p); }
    out.name = filenameFrom(r.headers['content-disposition']) || base;
    return out;
  }
  if (r.status < 400 && /html|xml|text\/plain/.test(type)) {
    out.kind = 'html';
    out.html = await readText(r, 2_500_000);
    return out;
  }
  r.res.destroy();
  return out;
}

// Первые мегабайты файла → ffprobe: узнаём длительность и разрешение, не доверяя ffprobe ходить в сеть.
async function probeHead(href, referer) {
  const tmp = path.join(DIRS.tmp, `h-${rid(6)}`);
  try {
    const r = await safeFetch(href, { timeout: 15000, headers: { range: 'bytes=0-6291455', 'accept-encoding': 'identity', ...(referer ? { referer } : {}) } });
    if (r.status >= 400) { r.res.destroy(); return null; }
    const fh = await fs.promises.open(tmp, 'w');
    let n = 0;
    try {
      for await (const c of r.res) {
        await fh.write(c);
        n += c.length;
        if (n >= 6291456) { r.res.destroy(); break; }
      }
    } catch {} finally { await fh.close(); }
    return summarize(await probe(tmp));
  } catch { return null; } finally { rmrf(tmp); }
}

async function directResult(pre, kind, pageTitle, referer) {
  const s = await probeHead(pre.finalUrl, referer);
  const q = s?.video && !s.video.still ? s.q : 0;
  const title = pageTitle || titleFromName(pre.name || 'Видео');
  return {
    type: 'video',
    kind,
    site: new URL(pre.finalUrl).hostname.replace(/^www\./, ''),
    title,
    uploader: '',
    duration: s?.duration || 0,
    thumbnail: '',
    hasVideo: s ? !!(s.video && !s.video.still) : !/^audio\//.test(pre.type),
    qualities: [{ height: 0, q, label: q ? qLabel(q, s.video.fps) : 'Оригинал', fps: 0, codec: '', size: pre.size || 0, approx: false }],
    audioSize: pre.size || 0,
    _job: { type: 'direct', url: pre.finalUrl, referer: referer || null, title },
  };
}

function hlsResult(href, kind, pageTitle, referer) {
  return {
    type: 'video', kind, site: new URL(href).hostname.replace(/^www\./, ''), title: pageTitle || 'Видео', uploader: '', duration: 0, thumbnail: '',
    hasVideo: true, qualities: [{ height: 0, q: 0, label: 'Оригинал', fps: 0, codec: '', size: 0, approx: true }], audioSize: 0,
    _job: { type: 'hls', url: href, referer: referer || null, title: pageTitle || 'Видео' },
  };
}

const decodeEnt = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
const FRAME_OK = /(youtube(-nocookie)?\.com\/embed|youtu\.be\/|rutube\.ru\/(play\/)?embed|vk\.(com|ru)\/video_ext|vkvideo\.ru\/video_ext|ok\.ru\/videoembed|dzen\.ru\/embed|vimeo\.com\/video|dailymotion\.com\/embed|kinescope|twitch\.tv|\/embed\/|\/player\/|player\.|video)/i;
const FRAME_SKIP = /(doubleclick|googlesyndication|recaptcha|facebook\.com\/plugins|disqus|yandex\.ru\/ads|an\.yandex|mc\.yandex|googletagmanager|adfox|about:blank|javascript:)/i;

export function findMediaInHtml(html, base) {
  const out = { direct: [], hls: [], iframes: [] };
  const abs = (u) => {
    try {
      const x = new URL(decodeEnt(String(u).trim().replace(/\\u0026/gi, '&').replace(/\\\//g, '/')), base);
      return /^https?:$/.test(x.protocol) ? x.href : null;
    } catch { return null; }
  };
  const push = (arr, u) => { if (u && !arr.includes(u)) arr.push(u); };
  const classify = (raw) => {
    const u = abs(raw);
    if (!u) return;
    const p = new URL(u).pathname.toLowerCase();
    if (p.endsWith('.m3u8')) push(out.hls, u);
    else if (/\.(mp4|m4v|webm|mov|mkv|mp3|m4a)$/.test(p)) push(out.direct, u);
    else if (FRAME_OK.test(u) && !FRAME_SKIP.test(u)) push(out.iframes, u);
  };
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/(?:property|name)\s*=\s*["'](?:og:video(?::(?:secure_)?url)?|twitter:player(?::stream)?)["']/i.test(m[0])) continue;
    const c = /content\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (c) classify(c[1]);
  }
  for (const m of html.matchAll(/<(?:video|source|embed)\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)) classify(m[1]);
  for (const m of html.matchAll(/<iframe\b[^>]*?\s(?:data-)?src\s*=\s*["']([^"']+)["']/gi)) {
    const u = abs(m[1]);
    if (u && FRAME_OK.test(u) && !FRAME_SKIP.test(u)) push(out.iframes, u);
  }
  for (const m of html.matchAll(/https?:(?:\\?\/){2}[^\s"'<>]+?\.(?:m3u8|mp4|webm)(?:\?[^\s"'<>\\]*)?/gi)) classify(m[0]);

  // Последняя надежда: плеер подгружается скриптом (lite-youtube, data-атрибуты, JSON) —
  // ищем в тексте страницы адреса известных плееров.
  const text = decodeEnt(html).replace(/\\\//g, '/');
  const ytSeen = new Set(out.iframes.map((u) => /(?:embed\/|v=|youtu\.be\/|shorts\/)([\w-]{11})/.exec(u)?.[1]).filter(Boolean));
  const yt = (id) => { if (!ytSeen.has(id)) { ytSeen.add(id); push(out.iframes, `https://www.youtube.com/watch?v=${id}`); } };
  for (const m of text.matchAll(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=|shorts\/|v\/)|youtu\.be\/)([\w-]{11})(?![\w-])/gi)) yt(m[1]);
  for (const m of text.matchAll(/<lite-youtube\b[^>]*?\bvideoid\s*=\s*["']([\w-]{11})["']/gi)) yt(m[1]);
  for (const m of text.matchAll(/data-(?:youtube|yt|video)-?id\s*=\s*["']([\w-]{11})["']/gi)) if (/youtu/i.test(text)) yt(m[1]);
  for (const m of text.matchAll(/(?:https?:)?\/\/(?:www\.)?(?:rutube\.ru\/(?:play\/embed|video)\/[0-9a-f]{32}|(?:vk\.com|vk\.ru|vkvideo\.ru)\/video_ext\.php\?[^\s"'<>]+|ok\.ru\/videoembed\/\d+|player\.vimeo\.com\/video\/\d+|dzen\.ru\/embed\/[\w-]+)/gi)) {
    push(out.iframes, abs(m[0].startsWith('//') ? `https:${m[0]}` : m[0]));
  }
  return out;
}

function pageTitle(html) {
  const og = /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*>/i.exec(html)?.[0];
  const c = og && /content\s*=\s*["']([^"']+)["']/i.exec(og)?.[1];
  const t = c || /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html)?.[1] || '';
  return decodeEnt(t).replace(/\s+/g, ' ').trim().slice(0, 200);
}

// ── Разбор ссылки ─────────────────────────────────────────────────────────
const resolved = new Map(); // id → { at, result }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of resolved) if (now - v.at > 3600e3) resolved.delete(k);
}, 600e3).unref();

function remember(result) {
  const id = rid(9);
  resolved.set(id, { at: Date.now(), result });
  const { _job, ...pub } = result;
  return { id, ...pub };
}

export async function resolveLink(raw, kind = 'video') {
  try {
    const input = normalizeUrl(raw);
    const url = await assertPublicUrl(input);
    const blocked = () => bad('Эта ссылка ведёт во внутреннюю сеть — такие адреса запрещены');

    // Незнакомый сайт сначала смотрим сами: это и проверка редиректов, и быстрый путь для прямых ссылок.
    let pre = null;
    if (!KNOWN.test(url.hostname)) {
      try { pre = await preflight(url.href); } catch (e) { if (e.code === 'EBLOCKED') throw blocked(); }
    }
    if (pre?.kind === 'file') return remember(await directResult(pre, kind));

    const target = pre?.finalUrl || url.href;
    let ytErr = null;
    if (tools.ytdlp) {
      try { return remember(await ytResolve(target, { kind })); } catch (e) {
        if (!e?.user || !['unsupported', 'extract', 'unknown', 'forbidden'].includes(e.code)) throw e;
        ytErr = e;
      }
    }

    // yt-dlp не понял страницу — разбираем HTML сами.
    if (pre?.kind === 'hls') return remember(hlsResult(pre.finalUrl, kind));
    let html = pre?.html, base = target;
    if (html == null) {
      try { const r = await fetchText(url.href, { maxBytes: 2_500_000 }); html = r.text; base = r.url.href; } catch (e) { if (e.code === 'EBLOCKED') throw blocked(); }
    }
    if (html) {
      const found = findMediaInHtml(html, base);
      const title = pageTitle(html);
      // Iframe-плееры отдаём yt-dlp с --referer страницы.
      for (const frame of found.iframes.slice(0, 5)) {
        if (!tools.ytdlp) break;
        try { await assertPublicUrl(frame); return remember(await ytResolve(frame, { kind, referer: base, fallbackTitle: title })); } catch (e) { if (e?.code === 'live' || e?.code === 'drm') throw e; }
      }
      for (const u of found.hls.slice(0, 3)) {
        try { await assertPublicUrl(u); } catch { continue; }
        if (tools.ytdlp) { try { return remember(await ytResolve(u, { kind, referer: base, fallbackTitle: title })); } catch {} }
        return remember(hlsResult(u, kind, title, base));
      }
      for (const u of found.direct.slice(0, 4)) {
        try {
          const p = await preflight(u, base);
          if (p.kind === 'file') return remember(await directResult(p, kind, title, base));
        } catch {}
      }
    }
    if (!tools.ytdlp) throw bad('yt-dlp не установлен, поэтому работают только прямые ссылки на файлы. Поставь его командой: npm run setup');
    throw ytErr || new UserError('Не получилось найти видео на этой странице', 'extract');
  } catch (e) {
    throw toHttp(e);
  }
}

export function jobFromResolved(id, { height, kind }) {
  const r = resolved.get(id);
  if (!r || Date.now() - r.at > 3600e3) throw bad('Разбор устарел — вставь ссылку ещё раз');
  const res = r.result;
  if (res.type === 'list') throw bad('Сначала выбери видео из списка');
  const job = { ...res._job, kind: kind === 'audio' ? 'audio' : 'video' };
  if (job.kind === 'video') {
    if (res.hasVideo === false) throw bad('По этой ссылке только звук — добавь её в разделе «Музыка»');
    const q = res.qualities.find((x) => x.height === Number(height)) || res.qualities[0];
    job.height = q?.height || 0;
    job.expect = q?.size || 0;
    job.label = q?.label || '';
  } else {
    job.expect = res.audioSize || 0;
  }
  return { title: res.title, job };
}

// ── Скачивание ────────────────────────────────────────────────────────────
function progressTracker(job, report) {
  const files = new Map(); // format_id → { d, t }
  let plan = null;
  const sizes = job.sizes || {};
  const onLine = (line) => {
    if (line.startsWith('ZP|')) {
      const [, status, done, total, est, speed, , fid, fi, fc] = line.split('|');
      const d = Number(done) || 0;
      let t = Number(total) || Number(est) || 0;
      if (!t && Number(fc) > 0) t = (d / Math.max(Number(fi) || 1, 1)) * Number(fc);
      files.set(fid, { d: status === 'finished' ? Math.max(d, t) : d, t: Math.max(t, d) });
      const ids = plan || [...files.keys()];
      let sumD = 0, sumT = 0;
      for (const id of ids) {
        const f = files.get(id);
        sumD += f ? f.d : 0;
        sumT += f ? Math.max(f.t, f.d) : (sizes[id] || 0);
      }
      // Видео и звук качаются отдельно — показываем один общий прогресс.
      let pct = sumT > 0 ? (sumD / sumT) * 100 : 0;
      if (!plan && job.kind !== 'audio' && files.size === 1 && job.height !== undefined) pct *= 0.93;
      const sp = Number(speed) || 0;
      report({ progress: Math.min(pct, 99), speed: sp, eta: sp > 0 ? Math.max(0, (sumT - sumD) / sp) : 0, stage: 'Скачивается' });
      return 'progress';
    }
    const m = /Downloading \d+ format\(s\):\s*(\S+)/.exec(line);
    if (m) plan = m[1].split('+');
    else if (/^\[Merger\]/.test(line)) report({ progress: 99, speed: 0, eta: 0, stage: 'Склеиваю видео и звук' });
    else if (/larger than max-filesize/i.test(line)) return 'nospace';
    return null;
  };
  return onLine;
}

async function ytDownload(m, job, tmp, report) {
  await ytGate();
  const free = await freeBytes(DATA);
  const maxSize = Math.max(64e6, Math.floor((free - 300e6) / 2.2)); // --max-filesize по свободному месту
  const H = Number(job.height) || 0;
  const args = [...ytBase(), '--no-playlist'];
  if (job.kind === 'audio') args.push('-f', 'ba/b', '-S', 'acodec:m4a');
  else {
    args.push('-f', H ? `bv*[height<=${H}]+ba/b[height<=${H}]/bv*+ba/b` : 'bv*+ba/b',
      '-S', 'res,fps,vcodec:h264,acodec:m4a', '--merge-output-format', 'mkv');
  }
  args.push(...NET_ARGS, '--newline', '--progress-template', `download:${PROG}`, '--max-filesize', String(maxSize),
    '--user-agent', UA, '--write-info-json', '--write-thumbnail', '--no-mtime',
    '-P', tmp, '-o', 'src.%(ext)s', '-o', 'thumbnail:thumb.%(ext)s', '-o', 'infojson:meta');
  if (job.referer) args.push('--referer', job.referer);
  args.push(...await cookieArgs(tmp), '--', job.url);

  const track = progressTracker(job, report);
  let nospace = false;
  tools.active++;
  let r;
  try {
    r = await runLines(m.id, tools.ytdlp, args, {
      stallMs: 240000,
      onOut: (line, child) => {
        if (track(line) === 'nospace') { nospace = true; try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
      },
    });
  } finally { tools.active--; }
  if (isCancelled(m.id)) throw new UserError('Загрузка отменена', 'cancelled');
  if (nospace) throw new UserError('Не хватает места на диске', 'nospace');
  if (r.stalled) throw new UserError('Сайт перестал отвечать', 'timeout');
  if (r.code !== 0) {
    logTail(`[${m.id}] yt-dlp завершился с ошибкой (${job.url}):`, r.tail);
    throw explain(r.tail);
  }
  const names = await fs.promises.readdir(tmp);
  const cands = [];
  for (const n of names) {
    if (!/^src\./.test(n) || /\.(part|ytdl|json|temp|jpe?g|png|webp)$/i.test(n) || /^src\.f[\w-]+\.\w+$/.test(n)) continue;
    cands.push({ n, size: (await fs.promises.stat(path.join(tmp, n))).size });
  }
  cands.sort((a, b) => b.size - a.size);
  if (!cands.length) {
    logTail(`[${m.id}] yt-dlp не оставил файла:`, r.tail);
    throw new UserError('Сайт отдал видео не полностью — попробуй ещё раз', 'network');
  }
  const thumb = names.find((n) => /^thumb\.(jpe?g|png|webp)$/i.test(n));
  return {
    file: path.join(tmp, cands[0].n),
    info: names.includes('meta.info.json') ? path.join(tmp, 'meta.info.json') : null,
    thumb: thumb ? path.join(tmp, thumb) : null,
  };
}

function extOf(href, type) {
  let p = '';
  try { p = new URL(href).pathname; } catch {}
  const m = /\.([a-z0-9]{2,5})$/i.exec(p);
  if (m && MEDIA_EXT.test(`.${m[1]}`)) return m[1].toLowerCase();
  const t = String(type || '');
  return /webm/.test(t) ? 'webm' : /matroska/.test(t) ? 'mkv' : /quicktime/.test(t) ? 'mov' : /mpeg$/.test(t) && /audio/.test(t) ? 'mp3' : /audio\/(mp4|x-m4a)/.test(t) ? 'm4a' : /flac/.test(t) ? 'flac' : /ogg/.test(t) ? 'ogg' : /wav/.test(t) ? 'wav' : 'mp4';
}

// Прямой файл: качаем сами, проверяя каждый редирект.
async function directDownload(m, job, tmp, report) {
  const free = await freeBytes(DATA);
  const dest = path.join(tmp, `src.${extOf(job.url)}`);
  const ab = trackAbort(m.id);
  let lastT = Date.now(), lastB = 0, speed = 0;
  try {
    await downloadToFile(job.url, dest, {
      signal: ab.signal,
      maxBytes: Math.max(64e6, free - 300e6),
      headers: job.referer ? { referer: job.referer } : {},
      onProgress: (got, total) => {
        const now = Date.now();
        if (now - lastT >= 700) {
          const inst = ((got - lastB) / (now - lastT)) * 1000;
          speed = speed ? speed * 0.7 + inst * 0.3 : inst;
          lastT = now; lastB = got;
          report({ progress: total ? Math.min((got / total) * 100, 99) : 0, speed, eta: total && speed ? (total - got) / speed : 0, stage: 'Скачивается' });
        }
      },
    });
  } catch (e) {
    if (isCancelled(m.id) || ab.signal.aborted) throw new UserError('Загрузка отменена', 'cancelled');
    if (e.code === 'EBLOCKED') throw new UserError('Ссылка ведёт во внутреннюю сеть — такие адреса запрещены', 'blocked');
    if (e.code === 'ENOSPC') throw new UserError('Не хватает места на диске', 'nospace');
    if (e.httpStatus === 403) throw new UserError('Сайт отказал в доступе (403)', 'forbidden');
    if (e.httpStatus === 404 || e.httpStatus === 410) throw new UserError('Файл удалён или недоступен', 'gone');
    if (e.httpStatus === 429) throw new UserError('Сайт ограничил частоту запросов — попробуй позже', 'rate');
    if (e.code === 'ETIMEDOUT') throw new UserError('Сайт слишком долго не отвечает', 'timeout');
    throw new UserError(`Не удалось скачать файл: ${e.message}`, 'network');
  } finally { ab.done(); }
  return { file: dest, info: null, thumb: null };
}

// HLS без yt-dlp: ffmpeg -i URL -c copy. Адреса из плейлиста проверяем заранее.
async function hlsDownload(m, job, tmp, report) {
  try {
    const { text, url } = await fetchText(job.url, { maxBytes: 1_500_000, headers: job.referer ? { referer: job.referer } : {} });
    const hosts = new Set();
    for (const line of text.split('\n')) {
      const l = line.trim();
      const uris = l.startsWith('#') ? [...l.matchAll(/URI="([^"]+)"/g)].map((x) => x[1]) : (l ? [l] : []);
      for (const u of uris) { try { hosts.add(new URL(u, url).hostname); } catch {} }
      if (hosts.size > 12) break;
    }
    for (const h of hosts) await lookupPublic(h);
  } catch (e) {
    if (e.code === 'EBLOCKED') throw new UserError('Плейлист ведёт во внутреннюю сеть — такие адреса запрещены', 'blocked');
  }
  const dest = path.join(tmp, 'src.mkv');
  const args = ['-user_agent', UA];
  if (job.referer) args.push('-referer', job.referer);
  args.push('-rw_timeout', '30000000', '-i', job.url, '-c', 'copy', '-progress', 'pipe:1', '-nostats', '-f', 'matroska', dest);
  let total = 0, seen = 0;
  const cmd = tools.ffmpeg;
  const r = await runLines(m.id, cmd, ['-hide_banner', '-nostdin', '-y', ...args], {
    stallMs: 240000,
    onErr: (line) => {
      const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
      if (d && !total) total = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
    },
    onOut: (line) => {
      const t = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (t) { seen = Number(t[1]) / 1e6; report({ progress: total ? Math.min((seen / total) * 100, 99) : 0, speed: 0, eta: 0, stage: 'Скачивается' }); }
    },
  });
  if (isCancelled(m.id)) throw new UserError('Загрузка отменена', 'cancelled');
  if (r.code !== 0) {
    logTail(`[${m.id}] ffmpeg (HLS) завершился с ошибкой:`, r.tail);
    if (r.stalled) throw new UserError('Сайт перестал отвечать', 'timeout');
    if (/403|forbidden/i.test(r.tail)) throw new UserError('Сайт отказал в доступе (403)', 'forbidden');
    if (/404|not found/i.test(r.tail)) throw new UserError('Видео удалено или недоступно', 'gone');
    if (/no space left/i.test(r.tail)) throw new UserError('Не хватает места на диске', 'nospace');
    throw new UserError('Не получилось скачать поток', 'network');
  }
  return { file: dest, info: null, thumb: null };
}

// Точка входа для очереди. Возвращает { file, info, thumb } во временной папке.
export async function downloadMedia(m, job, report) {
  const tmp = path.join(DIRS.tmp, m.id);
  await fs.promises.mkdir(tmp, { recursive: true });
  const free = await freeBytes(DATA);
  if (job.expect && free < job.expect * 2.2 + 200e6) {
    throw new UserError(`Не хватает места на диске: нужно около ${fmtBytes(job.expect * 2.2)}, свободно ${fmtBytes(free)}`, 'nospace');
  }
  try { await assertPublicUrl(job.url); } catch (e) { throw new UserError(e.message, 'blocked'); }
  if (isCancelled(m.id)) throw new UserError('Загрузка отменена', 'cancelled');

  if (job.type === 'direct') return directDownload(m, job, tmp, report);
  if (job.type === 'hls' || !tools.ytdlp) {
    if (job.type !== 'hls') throw new UserError('yt-dlp не установлен — поставь его командой: npm run setup', 'noytdlp');
    return hlsDownload(m, job, tmp, report);
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await ytDownload(m, job, tmp, report);
    } catch (e) {
      if (isCancelled(m.id) || e.code === 'cancelled') throw e;
      lastErr = e;
      if (attempt > 1) break;
      if (['timeout', 'network', 'forbidden'].includes(e.code)) { // таймаут → один автоповтор
        report({ stage: 'Повторяю попытку', speed: 0, eta: 0 });
        await sleep(2500);
        continue;
      }
      if (['extract', 'unknown'].includes(e.code) && tools.active === 0 && Date.now() - tools.lastCheck > 20 * 60e3) {
        report({ stage: 'Обновляю yt-dlp', speed: 0, eta: 0 });
        await refreshYtdlp({ force: true });
        continue;
      }
      break;
    }
  }
  if (/\.m3u8(\?|$)/i.test(job.url) && ['unsupported', 'extract', 'unknown'].includes(lastErr?.code)) return hlsDownload(m, job, tmp, report);
  throw lastErr;
}

// ── Готовые H.264-версии с сайта (чтобы не пересжимать) ───────────────────
// targets — нужные качества (360, 480, …). Возвращает Map q → { vid, aid }.
export function siteVariantPlan(info, src, targets) {
  const plan = new Map();
  const formats = info?.formats || [];
  const avc = formats.filter((f) => /^(avc|h264)/i.test(f.vcodec || '') && f.height && f.width && !f.has_drm
    && /^(https?|m3u8|m3u8_native|http_dash_segments)$/.test(f.protocol || ''));
  if (!avc.length || !src?.video) return plan;
  const audio = pickAacAudio(formats);
  for (const t of targets) {
    // та же частота кадров, что у исходника
    const c = avc.filter((f) => qOf(f.width, f.height) === t && (f.fps ? Math.abs(f.fps - src.video.fps) <= 1.5 : true));
    if (!c.length) continue;
    const rank = (f) => {
      const muxed = f.acodec && f.acodec !== 'none';
      return [/^https?$/.test(f.protocol) ? 1 : 0, !muxed && audio ? 1 : 0, f.filesize ? 1 : 0, f.tbr || 0];
    };
    const best = c.sort((a, b) => cmp(rank(b), rank(a)))[0];
    const muxed = best.acodec && best.acodec !== 'none';
    if (!muxed && !audio) continue;
    plan.set(t, { vid: best.format_id, aid: muxed ? null : audio.format_id });
  }
  return plan;
}

export function readInfo(mediaId) {
  try { return JSON.parse(fs.readFileSync(path.join(mediaDir(mediaId), 'info.json'), 'utf8')); } catch { return null; }
}

// Качаем готовую версию через --load-info-json (без повторного разбора), перепаковываем в MP4 и проверяем.
export async function downloadSiteVariant(m, v, src, onProgress) {
  const vj = JSON.parse(v.job || '{}');
  const mj = m.job ? JSON.parse(m.job) : {};
  const infoFile = path.join(mediaDir(m.id), 'info.json');
  const tmp = path.join(DIRS.tmp, `${m.id}-q${v.q}`);
  await rmrf(tmp);
  await fs.promises.mkdir(tmp, { recursive: true });
  const fmt = vj.aid ? `${vj.vid}+${vj.aid}` : vj.vid;
  const key = m.id;
  try {
    const common = ['-f', fmt, '--merge-output-format', 'mkv', ...NET_ARGS, '--newline', '--progress-template', `download:${PROG}`,
      '--user-agent', UA, '--no-mtime', '-P', tmp, '-o', 'v.%(ext)s', ...await cookieArgs(tmp)];
    if (mj.referer) common.push('--referer', mj.referer);
    const tries = [];
    if (fs.existsSync(infoFile)) tries.push([...ytBase(), '--load-info-json', infoFile, ...common]);
    if (mj.url) tries.push([...ytBase(), '--no-playlist', ...common, '--', mj.url]); // ссылки из info.json протухли — разбираем заново
    let ok = false, tail = '';
    for (const args of tries) {
      await ytGate();
      const track = progressTracker({ kind: 'video', sizes: mj.sizes || {} }, (p) => { if (p.progress != null) onProgress?.(p.progress * 0.97); });
      tools.active++;
      let r;
      try { r = await runLines(key, tools.ytdlp, args, { stallMs: 240000, onOut: (line) => { track(line); } }); } finally { tools.active--; }
      if (isCancelled(key)) throw Object.assign(new Error('отменено'), { cancelled: true });
      if (r.code === 0) { ok = true; break; }
      tail = r.tail;
      for (const n of await fs.promises.readdir(tmp).catch(() => [])) if (/^v\./.test(n)) await fs.promises.rm(path.join(tmp, n), { force: true }).catch(() => {});
    }
    if (!ok) throw new Error(explain(tail).message);
    const names = (await fs.promises.readdir(tmp)).filter((n) => /^v\./.test(n) && !/\.(part|ytdl|json)$/i.test(n) && !/^v\.f[\w-]+\.\w+$/.test(n));
    if (!names.length) throw new Error('yt-dlp не оставил файла');
    const got = path.join(tmp, names[0]);
    const gs = summarize(await probe(got));
    const out = path.join(mediaDir(m.id), `${v.file}.tmp`);
    const args = ['-i', got, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy'];
    if (gs.audio) args.push(...(gs.audio.codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2']));
    args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-f', 'mp4', out);
    const r = await ffmpegRun(key, args, 0, null);
    if (r.code !== 0) {
      await fs.promises.rm(out, { force: true }).catch(() => {});
      throw Object.assign(new Error(String(r.tail).split('\n').filter(Boolean).pop() || 'ошибка перепаковки'), { cancelled: !!r.signal });
    }
    return await finalizeVariant(m.id, v, out, src);
  } finally {
    rmrf(tmp);
  }
}
