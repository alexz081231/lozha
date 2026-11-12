// ffprobe/ffmpeg: разбор файла, приведение к виду, который играют браузеры, версии качества.
import fs from 'node:fs';
import path from 'node:path';
import { tools } from './tools.js';
import { run, runLines } from './procs.js';
import { sql } from './db.js';
import { mediaDir, patchMedia, patchVariant, getMedia } from './library.js';
import { clamp, log, titleFromName } from './util.js';

export class UserError extends Error {
  constructor(message, code = 'user') { super(message); this.code = code; this.user = true; }
}

export const LADDER = [360, 480, 720, 1080, 1440];
const STD = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const LANG = {
  ru: 'Русский', rus: 'Русский', en: 'English', eng: 'English', uk: 'Українська', ukr: 'Українська',
  de: 'Deutsch', deu: 'Deutsch', ger: 'Deutsch', fr: 'Français', fra: 'Français', fre: 'Français',
  es: 'Español', spa: 'Español', it: 'Italiano', ita: 'Italiano', ja: '日本語', jpn: '日本語',
  ko: '한국어', kor: '한국어', zh: '中文', zho: '中文', chi: '中文', pl: 'Polski', pol: 'Polski',
  pt: 'Português', por: 'Português', tr: 'Türkçe', tur: 'Türkçe', kk: 'Қазақша', kaz: 'Қазақша', be: 'Беларуская', bel: 'Беларуская',
};

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const ratio = (s) => {
  if (!s) return 0;
  const [a, b] = String(s).split(/[/:]/).map(Number);
  return b ? a / b : (a || 0);
};
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// «Качество» кадра: 1920×800 — это 1080p, 1080×1920 (Shorts) — тоже 1080p.
export function qOf(w, h) {
  if (!w || !h) return 0;
  const q = w >= h ? Math.max(h, Math.round((w * 9) / 16)) : Math.max(w, Math.round((h * 9) / 16));
  for (const s of STD) if (Math.abs(q - s) / s <= 0.07) return s;
  return q;
}
export function qLabel(q, fps) {
  const base = q >= 4000 ? '8K' : q >= 2000 ? '4K' : q >= 1400 ? '2K' : `${q}p`;
  const f = Math.round(fps || 0);
  return f >= 49 ? `${base}${f >= 100 ? f : f > 55 ? 60 : 50}` : base;
}

export async function probe(file) {
  const r = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 120000 });
  if (r.code !== 0) throw new UserError(`Файл не читается: ${r.stderr.trim().split('\n').pop() || 'неизвестный формат'}`);
  try { return JSON.parse(r.stdout); } catch { throw new UserError('Файл не читается: ffprobe вернул мусор'); }
}

export function summarize(p) {
  const streams = p.streams || [];
  const fmt = p.format || {};
  const vids = streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const pics = streams.filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic);
  const still = (s) => ['mjpeg', 'png', 'bmp', 'gif', 'webp'].includes(s.codec_name);
  const vs = vids.find((s) => !still(s)) || vids[0] || null;
  const auds = streams.filter((s) => s.codec_type === 'audio');
  const isRu = (s) => /^(ru|rus)$/i.test(s.tags?.language || '');
  // Русская дорожка — по умолчанию.
  const as = auds.find((s) => isRu(s) && s.disposition?.default) || auds.find(isRu) || auds.find((s) => s.disposition?.default) || auds[0] || null;
  const duration = num(fmt.duration) || num(vs?.duration) || num(as?.duration);

  let video = null;
  if (vs) {
    let fps = ratio(vs.avg_frame_rate);
    if (!(fps > 1 && fps <= 240)) fps = ratio(vs.r_frame_rate);
    if (!(fps > 1 && fps <= 240)) fps = 25;
    const rotation = num(vs.side_data_list?.find((d) => d.rotation != null)?.rotation ?? vs.tags?.rotate ?? 0);
    const turned = Math.abs(Math.round(rotation)) % 180 === 90;
    const sar = ratio(vs.sample_aspect_ratio) || 1;
    let dw = Math.abs(sar - 1) > 0.01 ? Math.round(vs.width * sar) : vs.width;
    let dh = vs.height;
    if (turned) [dw, dh] = [dh, dw];
    const pix = vs.pix_fmt || '';
    const mb = /(\d\d)(?:le|be)$/.exec(pix);
    const codec = vs.codec_name === 'h265' ? 'hevc' : vs.codec_name;
    video = {
      index: vs.index,
      codec,
      profile: vs.profile || '',
      level: num(vs.level),
      pix,
      bits: mb ? Number(mb[1]) : 8,
      chroma420: /^yuvj?420p/.test(pix),
      width: vs.width,
      height: vs.height,
      dispW: dw,
      dispH: dh,
      fps,
      hdr: ['smpte2084', 'arib-std-b67'].includes(vs.color_transfer),
      interlaced: !!vs.field_order && !['progressive', 'unknown'].includes(vs.field_order),
      still: still(vs),
    };
  }
  const audio = as ? {
    index: as.index,
    codec: as.codec_name,
    profile: as.profile || '',
    channels: num(as.channels),
    rate: num(as.sample_rate),
    lang: as.tags?.language || '',
    bitrate: num(as.bit_rate),
  } : null;
  const subs = streams.filter((s) => s.codec_type === 'subtitle' && TEXT_SUBS.has(s.codec_name)).map((s, i) => {
    const lang = (s.tags?.language || '').toLowerCase();
    const title = s.tags?.title || '';
    return { index: s.index, lang, label: [LANG[lang] || (lang && lang !== 'und' ? lang.toUpperCase() : ''), title].filter(Boolean).join(' — ') || `Субтитры ${i + 1}` };
  });
  const tags = {};
  for (const src of [fmt.tags, as?.tags]) for (const [k, v] of Object.entries(src || {})) if (!(k.toLowerCase() in tags)) tags[k.toLowerCase()] = String(v);
  const q = video ? qOf(video.dispW, video.dispH) : 0;
  return {
    format: String(fmt.format_name || ''),
    duration,
    size: num(fmt.size),
    bitrate: num(fmt.bit_rate),
    video, audio, subs, tags, q,
    cover: pics[0] || (video?.still ? vids[0] : null),
  };
}

// Строка кодека для canPlayType в браузере.
export function codecString(v) {
  if (!v) return '';
  const hex2 = (n) => Number(n).toString(16).padStart(2, '0');
  const pad2 = (n) => String(n).padStart(2, '0');
  const px = v.width * v.height;
  switch (v.codec) {
    case 'h264': {
      const prof = { 'Constrained Baseline': '42e0', Baseline: '4200', Main: '4d40', High: '6400', 'High 10': '6e00', 'High 4:2:2': '7a00' }[v.profile] || '6400';
      return `avc1.${prof}${hex2(v.level > 0 ? v.level : 40)}`;
    }
    case 'hevc':
      return `hvc1.${v.bits >= 10 ? '2.4' : '1.6'}.L${v.level > 0 ? v.level : 120}.B0`;
    case 'vp9': {
      const prof = Number(/\d/.exec(v.profile || '0')?.[0] || 0);
      let lvl = v.level > 0 ? v.level : 0;
      if (!lvl) {
        if (px <= 1280 * 720) lvl = v.fps > 31 ? 40 : 31;
        else if (px <= 2048 * 1152) lvl = v.fps > 31 ? 41 : 40;
        else if (px <= 4096 * 2304) lvl = v.fps > 61 ? 52 : v.fps > 31 ? 51 : 50;
        else lvl = v.fps > 31 ? 61 : 60;
      }
      return `vp09.${pad2(prof)}.${pad2(lvl)}.${pad2(v.bits || 8)}`;
    }
    case 'av1': {
      const prof = { Main: 0, High: 1, Professional: 2 }[v.profile] ?? 0;
      let lvl = v.level >= 0 && v.level < 32 && v.level !== 0 ? v.level : 0;
      if (!lvl) lvl = px <= 1280 * 720 ? 5 : px <= 2048 * 1152 ? (v.fps > 31 ? 9 : 8) : px <= 4096 * 2304 ? (v.fps > 31 ? 13 : 12) : 16;
      return `av01.${prof}.${pad2(lvl)}M.${pad2(v.bits || 8)}`;
    }
    default:
      return '';
  }
}

// ── ffmpeg ─────────────────────────────────────────────────────────────────
export function ffmpegRun(key, args, duration, onProgress) {
  const base = ['-hide_banner', '-nostdin', '-y', ...args];
  const cmd = tools.nice || tools.ffmpeg;
  const full = tools.nice ? ['-n', '10', tools.ffmpeg, ...base] : base;
  return runLines(key, cmd, full, {
    onOut: (line) => {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m && duration > 0) onProgress?.(clamp((Number(m[1]) / 1e6 / duration) * 100, 0, 100));
    },
  });
}

const RATE = { 360: 1100, 480: 2000, 720: 4200, 1080: 8500, 1440: 16000, 2160: 34000 };
function encodeArgs({ q, fps }) {
  const keys = Object.keys(RATE).map(Number);
  const near = keys.reduce((a, b) => (Math.abs(b - q) < Math.abs(a - q) ? b : a));
  let max = RATE[near] * (q / near);
  if (fps >= 49) max *= 1.5; // 60 кадров остаются 60 — и получают больше битрейта
  max = Math.round(max);
  const g = Math.max(24, Math.round(fps * 2));
  if (tools.encoder === 'libx264') {
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q <= 480 ? 23 : q <= 720 ? 22 : 21),
      '-maxrate', `${max}k`, '-bufsize', `${max * 2}k`, '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', String(g)];
  }
  return ['-c:v', tools.encoder, '-b:v', `${Math.round(max * 0.7)}k`, '-maxrate', `${max}k`, '-pix_fmt', 'yuv420p', '-g', String(g)];
}

function filters({ w, h, hdr, interlaced, tonemap = true }) {
  const f = [];
  if (interlaced) f.push('yadif=0:-1:1');
  f.push(`scale=${w}:${h}:flags=bicubic`);
  if (hdr && tonemap && tools.hdrTonemap) {
    f.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  }
  f.push('setsar=1', 'format=yuv420p');
  return f.join(',');
}

const CLEAN = ['-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-max_muxing_queue_size', '4096'];

function findOrig(dir) {
  try {
    const f = fs.readdirSync(dir).find((n) => /^orig\./.test(n));
    return f ? path.join(dir, f) : null;
  } catch { return null; }
}
export const origOf = (id) => findOrig(mediaDir(id));

async function makePoster(id, input, s, { square = false } = {}) {
  const dir = mediaDir(id);
  const out = path.join(dir, 'poster.jpg');
  const thumb = (() => { try { return fs.readdirSync(dir).find((n) => /^thumb\.(jpe?g|png|webp)$/i.test(n)); } catch { return null; } })();
  const crop = square ? "crop='min(iw,ih)':'min(iw,ih)'," : '';
  const size = square ? "scale='min(800,iw)':-2" : "scale='min(960,iw)':-2";
  // 1) превью с сайта, 2) встроенная обложка, 3) кадр из видео
  if (thumb) {
    const r = await run(tools.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', path.join(dir, thumb), '-frames:v', '1', '-vf', `${crop}${size}`, '-q:v', '3', out], { timeout: 60000 });
    fs.promises.rm(path.join(dir, thumb), { force: true }).catch(() => {});
    if (r.code === 0 && fs.existsSync(out)) return true;
  }
  if (s.cover) {
    const r = await run(tools.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', input, '-map', `0:${s.cover.index}`, '-frames:v', '1', '-vf', `${crop}${size}`, '-q:v', '3', out], { timeout: 60000 });
    if (r.code === 0 && fs.existsSync(out)) return true;
  }
  if (s.video && !s.video.still) {
    const at = s.duration > 12 ? Math.min(s.duration * 0.12, 90) : s.duration / 3;
    for (const tonemap of [true, false]) {
      const vf = [];
      if (s.video.hdr && tonemap && tools.hdrTonemap) vf.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p');
      vf.push(`${crop}${size}`);
      const r = await run(tools.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-ss', String(Math.max(0, at)), '-i', input, '-frames:v', '1', '-vf', vf.join(','), '-q:v', '3', out], { timeout: 120000 });
      if (r.code === 0 && fs.existsSync(out)) return true;
      if (!s.video.hdr) break;
    }
  }
  return false;
}

// ── Приём видео ────────────────────────────────────────────────────────────
// Возвращает сводку исходника (для планирования версий).
export async function ingestVideo(m, onProgress) {
  const dir = mediaDir(m.id);
  const orig = findOrig(dir);
  if (!orig) throw new UserError('Исходный файл потерялся — загрузи его заново');
  const s = summarize(await probe(orig));
  if (!s.video || s.video.still) throw new UserError('В файле нет видеодорожки');
  if (!(s.duration > 0)) throw new UserError('Не удалось определить длительность видео');
  const v = s.video, a = s.audio;
  const tmp = path.join(dir, 'source.tmp.mp4');
  const out = path.join(dir, 'source.mp4');

  // Что браузеры играют — не трогаем: H.264 (8 бит 4:2:0), а VP9/HEVC/AV1 храним как есть.
  const keep = (v.codec === 'h264' && v.bits === 8 && v.chroma420) || ['hevc', 'vp9', 'av1'].includes(v.codec);
  const dims = { w: even(v.dispW), h: even(v.dispH) };

  const attempt = (mode, tonemap = true) => {
    const args = [];
    if (/avi|mpegts|mpeg|vob|asf|rm/.test(s.format)) args.push('-fflags', '+genpts');
    args.push('-i', orig, '-map', `0:${v.index}`);
    if (a) args.push('-map', `0:${a.index}`);
    if (mode === 'copy') {
      args.push('-c:v', 'copy');
      if (v.codec === 'hevc') args.push('-tag:v', 'hvc1');
    } else {
      // Старые кодеки → H.264 того же разрешения и fps.
      args.push('-vf', filters({ ...dims, hdr: v.hdr, interlaced: v.interlaced, tonemap }), ...encodeArgs({ q: s.q, fps: v.fps }));
    }
    if (a) {
      if (a.codec === 'aac') args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-b:a', a.channels === 1 ? '128k' : '192k', ...(a.channels > 2 ? ['-ac', '2'] : []));
    }
    args.push(...CLEAN, '-progress', 'pipe:1', '-nostats', '-f', 'mp4', tmp);
    return ffmpegRun(m.id, args, s.duration, onProgress);
  };
  const verify = async () => {
    const s2 = summarize(await probe(tmp));
    if (!s2.video) throw new Error('в результате нет видео');
    if (s.duration > 5 && Math.abs(s2.duration - s.duration) > Math.max(3, s.duration * 0.03)) throw new Error('длительность не совпала');
    return s2;
  };

  let mode = keep ? 'copy' : 'encode';
  let r = await attempt(mode);
  let s2 = null;
  if (r.code === 0) { try { s2 = await verify(); } catch (e) { r = { code: 1, tail: e.message }; } }
  if (r.code !== 0 && mode === 'copy') {
    log(`[${m.id}] перепаковка не удалась (${String(r.tail).split('\n').pop()}), пересжимаю в H.264`);
    mode = 'encode';
    r = await attempt(mode);
    if (r.code === 0) { try { s2 = await verify(); } catch (e) { r = { code: 1, tail: e.message }; } }
  }
  if (r.code !== 0 && mode === 'encode' && v.hdr) {
    r = await attempt('encode', false);
    if (r.code === 0) { try { s2 = await verify(); } catch (e) { r = { code: 1, tail: e.message }; } }
  }
  if (r.code !== 0 || !s2) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    if (r.signal) throw new UserError('Обработка прервана', 'cancelled');
    log(`[${m.id}] ffmpeg:\n${r.tail}`);
    throw new UserError(`Не удалось обработать видео: ${String(r.tail).split('\n').filter(Boolean).pop() || 'ошибка ffmpeg'}`);
  }
  await fs.promises.rename(tmp, out);
  const st = await fs.promises.stat(out);
  const sv = s2.video;

  // Текстовые субтитры → WebVTT.
  sql('DELETE FROM subtitles WHERE media_id = ?').run(m.id);
  for (let i = 0; i < s.subs.length && i < 12; i++) {
    const sub = s.subs[i];
    const file = `sub_${i}.vtt`;
    const rs = await run(tools.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', orig, '-map', `0:${sub.index}`, '-c:s', 'webvtt', '-f', 'webvtt', path.join(dir, file)], { timeout: 600000, key: m.id });
    if (rs.code === 0) sql('INSERT INTO subtitles (media_id, lang, label, file) VALUES (?, ?, ?, ?)').run(m.id, sub.lang, sub.label, file);
  }

  const hasPoster = await makePoster(m.id, out, s2);

  const q = qOf(sv.dispW, sv.dispH);
  sql('DELETE FROM variants WHERE media_id = ?').run(m.id);
  sql(`INSERT INTO variants (media_id, kind, q, label, width, height, fps, codec, codec_str, file, size, bitrate, status, progress, origin, created_at)
       VALUES (?, 'source', ?, ?, ?, ?, ?, ?, ?, 'source.mp4', ?, ?, 'ready', 100, 'source', ?)`)
    .run(m.id, q, qLabel(q, sv.fps), sv.dispW, sv.dispH, sv.fps, sv.codec, codecString(sv), st.size, Math.round((st.size * 8) / s2.duration), Date.now());

  patchMedia(m.id, {
    status: 'ready', stage: '', progress: 100, error: null, retryable: 0,
    duration: s2.duration, width: sv.dispW, height: sv.dispH, fps: sv.fps,
    vcodec: sv.codec, acodec: s2.audio?.codec || '', poster: hasPoster ? Date.now() : 0,
  });
  await fs.promises.rm(orig, { force: true }).catch(() => {});
  return { ...s2, q, hdr: sv.hdr };
}

// ── Версия качества: локальное пересжатие ──────────────────────────────────
export async function transcodeVariant(mediaId, v, onProgress) {
  const dir = mediaDir(mediaId);
  const input = path.join(dir, 'source.mp4');
  const src = summarize(await probe(input));
  if (!src.video) throw new Error('нет исходника');
  const scale = v.q / src.q;
  const dims = { w: even(src.video.dispW * scale), h: even(src.video.dispH * scale) };
  const tmp = path.join(dir, `${v.file}.tmp`);
  const go = (tonemap) => ffmpegRun(mediaId, [
    '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', filters({ ...dims, hdr: src.video.hdr, interlaced: false, tonemap }),
    ...encodeArgs({ q: v.q, fps: src.video.fps }),
    '-c:a', 'copy', ...CLEAN, '-progress', 'pipe:1', '-nostats', '-f', 'mp4', tmp,
  ], src.duration, onProgress);
  let r = await go(true);
  if (r.code !== 0 && src.video.hdr && !r.signal) r = await go(false);
  if (r.code !== 0) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    const e = new Error(String(r.tail).split('\n').filter(Boolean).pop() || 'ошибка ffmpeg');
    e.cancelled = !!r.signal;
    throw e;
  }
  return finalizeVariant(mediaId, v, tmp, src);
}

// Проверяет готовый файл версии (кодек, длительность) и публикует его.
export async function finalizeVariant(mediaId, v, tmpFile, src) {
  const dir = mediaDir(mediaId);
  const s = summarize(await probe(tmpFile));
  const fail = async (why) => { await fs.promises.rm(tmpFile, { force: true }).catch(() => {}); throw new Error(why); };
  if (!s.video || s.video.codec !== 'h264') await fail(`кодек ${s.video?.codec || 'нет видео'} вместо H.264`);
  if (Math.abs(s.duration - src.duration) > Math.max(2, src.duration * 0.015)) await fail('длительность не совпала с исходником');
  if (src.video && Math.abs(s.video.fps - src.video.fps) > 1.5) await fail(`частота кадров ${s.video.fps.toFixed(1)} вместо ${src.video.fps.toFixed(1)}`);
  if (!getMedia(mediaId)) await fail('фильм удалён');
  const out = path.join(dir, v.file);
  await fs.promises.rename(tmpFile, out);
  const st = await fs.promises.stat(out);
  patchVariant(v, {
    status: 'ready', progress: 100, width: s.video.dispW, height: s.video.dispH, fps: s.video.fps,
    codec: 'h264', codec_str: codecString(s.video), size: st.size, bitrate: Math.round((st.size * 8) / s.duration),
    label: qLabel(v.q, s.video.fps), created_at: Date.now(),
  });
  return s;
}

// ── Приём музыки ───────────────────────────────────────────────────────────
export async function ingestAudio(m, onProgress) {
  const dir = mediaDir(m.id);
  const orig = findOrig(dir);
  if (!orig) throw new UserError('Исходный файл потерялся — загрузи его заново');
  const s = summarize(await probe(orig));
  const a = s.audio;
  if (!a) throw new UserError('В файле нет звука');
  if (!(s.duration > 0)) throw new UserError('Не удалось определить длительность трека');

  // Что браузеры играют — оставляем без пересжатия.
  let ext, codecArgs;
  if (a.codec === 'mp3') { ext = 'mp3'; codecArgs = ['-c:a', 'copy', '-f', 'mp3']; }
  else if (a.codec === 'aac') { ext = 'm4a'; codecArgs = ['-c:a', 'copy', '-movflags', '+faststart', '-f', 'mp4']; }
  else if (a.codec === 'flac') { ext = 'flac'; codecArgs = ['-c:a', 'copy', '-f', 'flac']; }
  else if (/^pcm_|^alac$|^ape$|^wavpack$/.test(a.codec)) { ext = 'flac'; codecArgs = ['-c:a', 'flac', '-f', 'flac']; } // без потерь → FLAC
  else { ext = 'm4a'; codecArgs = ['-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-f', 'mp4']; }

  const tmp = path.join(dir, `audio.tmp.${ext}`);
  const go = (args) => ffmpegRun(m.id, ['-i', orig, '-map', `0:${a.index}`, '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', ...args, '-progress', 'pipe:1', '-nostats', tmp], s.duration, onProgress);
  let r = await go(codecArgs);
  if (r.code !== 0 && !r.signal && codecArgs[1] === 'copy') {
    ext = 'm4a';
    r = await ffmpegRun(m.id, ['-i', orig, '-map', `0:${a.index}`, '-vn', '-sn', '-dn', '-map_metadata', '-1', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', tmp], s.duration, onProgress);
  }
  if (r.code !== 0) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    if (r.signal) throw new UserError('Обработка прервана', 'cancelled');
    log(`[${m.id}] ffmpeg:\n${r.tail}`);
    throw new UserError(`Не удалось обработать трек: ${String(r.tail).split('\n').filter(Boolean).pop() || 'ошибка ffmpeg'}`);
  }
  const finalFile = `audio.${ext}`;
  await fs.promises.rename(tmp, path.join(dir, finalFile));
  const s2 = summarize(await probe(path.join(dir, finalFile)));

  const hasPoster = await makePoster(m.id, orig, s, { square: true });

  // Название и исполнитель — из тегов; для ссылок их заранее кладёт загрузчик.
  const job = m.job ? JSON.parse(m.job) : {};
  let title = s.tags.title || job.track || '';
  let artist = s.tags.artist || s.tags.album_artist || job.artist || '';
  if (!title) {
    const base = job.title || m.title || titleFromName(path.basename(orig));
    const parts = base.split(/\s+[-–—]\s+/);
    if (!artist && parts.length >= 2) { artist = parts[0]; title = parts.slice(1).join(' — '); } else title = base;
  }
  if (!artist && job.uploader) artist = String(job.uploader).replace(/\s*-\s*Topic$/i, '');

  patchMedia(m.id, {
    status: 'ready', stage: '', progress: 100, error: null, retryable: 0,
    title: title.slice(0, 300), artist: artist.slice(0, 200), duration: s2.duration || s.duration,
    acodec: s2.audio?.codec || a.codec, file: finalFile, poster: hasPoster ? Date.now() : 0,
  });
  await fs.promises.rm(orig, { force: true }).catch(() => {});
  return s2;
}
