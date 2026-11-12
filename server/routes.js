// HTTP API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { route, sendJson, readJson, readBody, sendFile, mime } from './http.js';
import { sql, getSetting, setSetting, tx } from './db.js';
import { DIRS, DATA, INVITE_TTL, COOKIES_FILE, DEV_TOKEN, APP_NAME, ACCEL } from './config.js';
import * as auth from './auth.js';
import * as hub from './hub.js';
import { bad, HttpError, rid, freeBytes, dirSize, log } from './util.js';
import { listMedia, getMedia, patchMedia, createMedia } from './library.js';
import { resolveLink, jobFromResolved } from './links.js';
import { enqueueDownload, enqueueIngest, cancelAndRemove, retry } from './queue.js';
import * as uploads from './uploads.js';
import { openRoom, roomsSummary, onMediaRemoved, roomFor } from './rooms.js';
import { tools, refreshYtdlp } from './tools.js';

const isOwner = (u) => u.role === 'owner';
const canAddMusic = (u) => isOwner(u) || getSetting('friendsMusic', true) !== false;
const canAdd = (u, kind) => (kind === 'audio' ? canAddMusic(u) : isOwner(u));
const canEdit = (u, m) => isOwner(u) || (m.kind === 'audio' && m.added_by === u.id);
const waitText = (s) => (s >= 90 ? `${Math.ceil(s / 60)} мин` : `${s} с`);

let dummyHash = null;

export function registerRoutes() {
  // ── Вход и профиль ──────────────────────────────────────────────────────
  route('GET', '/api/me', async ({ req, res, user }) => {
    sendJson(res, 200, {
      app: APP_NAME,
      user: user ? auth.publicUser(user) : null,
      can: user ? { films: isOwner(user), music: canAddMusic(user) } : null,
      ytdlp: !!tools.ytdlp,
      secure: auth.isSecure(req),
      warnPass: !!user && isOwner(user) && getSetting('ownerDefaultPass', false) === true,
      now: Date.now(),
    });
  }, { auth: false });

  route('POST', '/api/login', async ({ req, res }) => {
    const body = await readJson(req);
    const key = auth.loginKey(body.login);
    const ip = auth.clientIp(req);
    const keys = [`u:${key}|${ip}`, `ip:${ip}`];
    const wait = auth.guardWait(keys);
    if (wait) throw bad(`Слишком много попыток. Попробуй через ${waitText(wait)}`, 429, { wait });
    const u = key ? sql('SELECT * FROM users WHERE login_key = ?').get(key) : null;
    let ok = false;
    if (u) ok = await auth.verifyPassword(String(body.password || ''), u.pass);
    else { // одинаковое время ответа, есть такой логин или нет
      dummyHash ||= await auth.hashPassword(rid(12));
      await auth.verifyPassword('x', dummyHash);
    }
    if (!ok) {
      auth.guardFail(keys, { [keys[1]]: 20 });
      throw bad('Неверный логин или пароль', 401);
    }
    auth.guardOk([keys[0]]);
    const token = auth.createSession(u.id, req.headers['user-agent']);
    sendJson(res, 200, { user: auth.publicUser(u) }, { 'set-cookie': auth.sessionCookie(req, token) });
  }, { auth: false });

  route('POST', '/api/logout', async ({ req, res, user }) => {
    auth.destroySession(user.sid);
    hub.dropSession(user.sid);
    sendJson(res, 200, { ok: true }, { 'set-cookie': auth.sessionCookie(req, null) });
  });

  route('POST', '/api/logout-all', async ({ req, res, user }) => {
    auth.destroyUserSessions(user.id);
    hub.dropUser(user.id, 'Вы вышли на всех устройствах');
    sendJson(res, 200, { ok: true }, { 'set-cookie': auth.sessionCookie(req, null) });
  });

  const liveInvite = (token) => {
    const inv = sql('SELECT * FROM invites WHERE token = ?').get(String(token || ''));
    return inv && !inv.used_by && inv.expires_at > Date.now() ? inv : null;
  };

  route('GET', '/api/invite/:token', async ({ res, params }) => {
    const inv = liveInvite(params.token);
    if (!inv) throw bad('Приглашение недействительно: оно уже использовано или истекло', 404);
    const by = sql('SELECT name FROM users WHERE id = ?').get(inv.created_by);
    sendJson(res, 200, { ok: true, by: by?.name || '', expiresAt: inv.expires_at });
  }, { auth: false });

  route('POST', '/api/register', async ({ req, res }) => {
    const body = await readJson(req);
    const ip = auth.clientIp(req);
    const keys = [`reg:${ip}`];
    const wait = auth.guardWait(keys);
    if (wait) throw bad(`Слишком много попыток. Попробуй через ${waitText(wait)}`, 429);
    if (!liveInvite(body.token)) {
      auth.guardFail(keys, { [keys[0]]: 10 });
      throw bad('Приглашение недействительно: оно уже использовано или истекло', 404);
    }
    const login = String(body.login || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 40) || login;
    const password = String(body.password || '');
    if (login.length < 2 || login.length > 32) throw bad('Логин — от 2 до 32 символов');
    if (!/^[\p{L}\p{N} ._-]+$/u.test(login)) throw bad('В логине можно буквы, цифры, пробел, точку, дефис и подчёркивание');
    if (password.length < 8 || password.length > 200) throw bad('Пароль — не короче 8 символов');
    const key = auth.loginKey(login);
    if (sql('SELECT id FROM users WHERE login_key = ?').get(key)) throw bad('Такой логин уже занят');
    const pass = await auth.hashPassword(password);
    const id = tx(() => {
      const inv = liveInvite(body.token); // одноразовое: проверяем ещё раз внутри транзакции
      if (!inv) throw bad('Приглашение уже использовано', 404);
      const r = sql('INSERT INTO users (login, login_key, name, pass, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(login, key, name, pass, 'friend', Date.now());
      const uid = Number(r.lastInsertRowid);
      sql('UPDATE invites SET used_by = ?, used_at = ? WHERE token = ?').run(uid, Date.now(), inv.token);
      return uid;
    });
    const token = auth.createSession(id, req.headers['user-agent']);
    hub.toOwners({ t: 'friends' });
    log(`по приглашению зарегистрировался друг: ${login}`);
    sendJson(res, 200, { user: auth.publicUser(sql('SELECT * FROM users WHERE id = ?').get(id)) }, { 'set-cookie': auth.sessionCookie(req, token) });
  }, { auth: false });

  route('POST', '/api/profile', async ({ req, res, user }) => {
    const body = await readJson(req);
    const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) throw bad('Имя не может быть пустым');
    sql('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
    hub.refreshUser(user.id);
    hub.toOwners({ t: 'friends' });
    sendJson(res, 200, { user: auth.publicUser(sql('SELECT * FROM users WHERE id = ?').get(user.id)) });
  });

  const dropAvatar = (file) => { if (file) fs.promises.rm(path.join(DIRS.avatars, file), { force: true }).catch(() => {}); };

  route('PUT', '/api/profile/avatar', async ({ req, res, user }) => {
    const buf = await readBody(req, 600_000);
    const ext = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? 'jpg'
      : buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png'
        : buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP' ? 'webp' : null;
    if (!ext) throw bad('Нужна картинка JPEG, PNG или WebP');
    const file = `${user.id}-${Date.now().toString(36)}.${ext}`;
    await fs.promises.writeFile(path.join(DIRS.avatars, file), buf);
    dropAvatar(user.avatar);
    sql('UPDATE users SET avatar = ? WHERE id = ?').run(file, user.id);
    hub.refreshUser(user.id);
    hub.toOwners({ t: 'friends' });
    sendJson(res, 200, { user: auth.publicUser(sql('SELECT * FROM users WHERE id = ?').get(user.id)) });
  });

  route('DELETE', '/api/profile/avatar', async ({ res, user }) => {
    dropAvatar(user.avatar);
    sql('UPDATE users SET avatar = NULL WHERE id = ?').run(user.id);
    hub.refreshUser(user.id);
    sendJson(res, 200, { user: auth.publicUser(sql('SELECT * FROM users WHERE id = ?').get(user.id)) });
  });

  route('POST', '/api/profile/password', async ({ req, res, user }) => {
    const body = await readJson(req);
    const keys = [`pw:${user.id}`];
    const wait = auth.guardWait(keys);
    if (wait) throw bad(`Слишком много попыток. Попробуй через ${waitText(wait)}`, 429);
    if (!(await auth.verifyPassword(String(body.current || ''), user.pass))) {
      auth.guardFail(keys);
      throw bad('Текущий пароль введён неверно', 403);
    }
    const next = String(body.next || '');
    if (next.length < 8 || next.length > 200) throw bad('Новый пароль — не короче 8 символов');
    sql('UPDATE users SET pass = ? WHERE id = ?').run(await auth.hashPassword(next), user.id);
    if (isOwner(user)) setSetting('ownerDefaultPass', false);
    auth.destroyUserSessions(user.id, user.sid); // остальные устройства выходят
    hub.dropUserExcept(user.id, user.sid);
    sendJson(res, 200, { ok: true });
  });

  route('GET', '/avatars/:file', async ({ req, res, params }) => {
    if (!/^\d+-[a-z0-9]+\.(jpg|png|webp)$/.test(params.file)) throw new HttpError(404, 'Не найдено');
    await sendFile(req, res, path.join(DIRS.avatars, params.file), { cache: 'private, max-age=31536000, immutable' });
  });

  // ── Друзья и приглашения (владелец) ─────────────────────────────────────
  route('GET', '/api/friends', async ({ res }) => {
    const online = new Set(hub.onlineIds());
    const now = Date.now();
    sendJson(res, 200, {
      friends: sql('SELECT * FROM users ORDER BY role DESC, created_at').all().map((u) => ({
        ...auth.publicUser(u), createdAt: u.created_at, online: online.has(u.id),
      })),
      invites: sql('SELECT * FROM invites WHERE used_by IS NULL AND expires_at > ? ORDER BY created_at DESC').all(now)
        .map((i) => ({ token: i.token, createdAt: i.created_at, expiresAt: i.expires_at })),
    });
  }, { auth: 'owner' });

  route('DELETE', '/api/friends/:id', async ({ res, params }) => {
    const u = sql('SELECT * FROM users WHERE id = ?').get(Number(params.id));
    if (!u) throw bad('Нет такого пользователя', 404);
    if (u.role === 'owner') throw bad('Владельца удалить нельзя');
    sql('DELETE FROM users WHERE id = ?').run(u.id);
    dropAvatar(u.avatar);
    hub.dropUser(u.id, 'Ваш аккаунт удалён');
    sendJson(res, 200, { ok: true });
  }, { auth: 'owner' });

  route('POST', '/api/invites', async ({ res, user }) => {
    const token = rid(18);
    const now = Date.now();
    sql('DELETE FROM invites WHERE expires_at < ?').run(now - 30 * 86400e3);
    sql('INSERT INTO invites (token, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, user.id, now, now + INVITE_TTL);
    sendJson(res, 200, { token, createdAt: now, expiresAt: now + INVITE_TTL });
  }, { auth: 'owner' });

  route('DELETE', '/api/invites/:token', async ({ res, params }) => {
    sql('DELETE FROM invites WHERE token = ? AND used_by IS NULL').run(params.token);
    sendJson(res, 200, { ok: true });
  }, { auth: 'owner' });

  // ── Система (владелец) ──────────────────────────────────────────────────
  const cookiesInfo = () => {
    try { const st = fs.statSync(COOKIES_FILE); return { present: true, size: st.size, updatedAt: st.mtimeMs }; } catch { return { present: false }; }
  };
  const systemInfo = async () => ({
    disk: { free: await freeBytes(DATA), used: await dirSize(DIRS.media) },
    ytdlp: { found: !!tools.ytdlp, version: tools.ytdlpVersion, note: tools.lastNote, checkedAt: tools.lastCheck, updating: !!tools.updating },
    cookies: cookiesInfo(),
    settings: { friendsMusic: getSetting('friendsMusic', true) !== false },
  });

  route('GET', '/api/system', async ({ res }) => sendJson(res, 200, await systemInfo()), { auth: 'owner' });

  route('PUT', '/api/system/cookies', async ({ req, res }) => {
    const text = (await readBody(req, 3_000_000)).toString('utf8');
    const rows = text.split('\n').filter((l) => l.trim() && !l.startsWith('#') || l.startsWith('#HttpOnly_'));
    if (!rows.length || !rows.some((l) => l.split('\t').length >= 7)) {
      throw bad('Это не похоже на cookies.txt. Нужен файл в формате Netscape — его делает расширение браузера «Get cookies.txt LOCALLY»');
    }
    await fs.promises.writeFile(COOKIES_FILE, text, { mode: 0o600 });
    sendJson(res, 200, await systemInfo());
  }, { auth: 'owner' });

  route('DELETE', '/api/system/cookies', async ({ res }) => {
    await fs.promises.rm(COOKIES_FILE, { force: true });
    sendJson(res, 200, await systemInfo());
  }, { auth: 'owner' });

  route('POST', '/api/system/ytdlp-update', async ({ res }) => {
    await refreshYtdlp({ force: true });
    sendJson(res, 200, await systemInfo());
  }, { auth: 'owner' });

  route('POST', '/api/system/settings', async ({ req, res }) => {
    const body = await readJson(req);
    if (typeof body.friendsMusic === 'boolean') setSetting('friendsMusic', body.friendsMusic);
    hub.broadcast({ t: 'perms' });
    sendJson(res, 200, await systemInfo());
  }, { auth: 'owner' });

  // ── Библиотека ──────────────────────────────────────────────────────────
  route('GET', '/api/media', async ({ res }) => sendJson(res, 200, { media: listMedia() }));

  route('PATCH', '/api/media/:id', async ({ req, res, params, user }) => {
    const m = getMedia(params.id);
    if (!m) throw bad('Не найдено', 404);
    if (!canEdit(user, m)) throw bad('Это может только владелец', 403);
    const body = await readJson(req);
    const patch = {};
    if (typeof body.title === 'string') {
      const t = body.title.replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!t) throw bad('Название не может быть пустым');
      patch.title = t;
    }
    if (typeof body.artist === 'string') patch.artist = body.artist.replace(/\s+/g, ' ').trim().slice(0, 200);
    patchMedia(m.id, patch);
    sendJson(res, 200, { ok: true });
  });

  route('DELETE', '/api/media/:id', async ({ res, params, user }) => {
    const m = getMedia(params.id);
    if (!m) return sendJson(res, 200, { ok: true });
    if (!canEdit(user, m)) throw bad('Это может только владелец', 403);
    onMediaRemoved(m.id);
    await cancelAndRemove(m.id);
    sendJson(res, 200, { ok: true });
  });

  route('POST', '/api/media/:id/retry', async ({ res, params, user }) => {
    const m = getMedia(params.id);
    if (!m) throw bad('Не найдено', 404);
    if (!canEdit(user, m)) throw bad('Это может только владелец', 403);
    retry(m.id);
    sendJson(res, 200, { ok: true });
  });

  // ── Загрузка по ссылке ──────────────────────────────────────────────────
  route('POST', '/api/links/resolve', async ({ req, res, user }) => {
    const body = await readJson(req);
    const kind = body.kind === 'audio' ? 'audio' : 'video';
    if (!canAdd(user, kind)) throw bad(kind === 'audio' ? 'Владелец отключил добавление музыки друзьями' : 'Добавлять фильмы может только владелец', 403);
    sendJson(res, 200, await resolveLink(body.url, kind));
  });

  route('POST', '/api/links/download', async ({ req, res, user }) => {
    const body = await readJson(req);
    const kind = body.kind === 'audio' ? 'audio' : 'video';
    if (!canAdd(user, kind)) throw bad('Недостаточно прав', 403);
    const { title, job } = jobFromResolved(String(body.id || ''), { height: body.height, kind });
    const mediaId = createMedia({ kind, title, status: 'queued', stage: 'В очереди', origin: 'link', job, addedBy: user.id });
    enqueueDownload(mediaId);
    sendJson(res, 200, { mediaId });
  });

  // ── Загрузка файлов ─────────────────────────────────────────────────────
  route('GET', '/api/uploads', async ({ res, user }) => sendJson(res, 200, { uploads: uploads.listUploads(user) }));

  route('POST', '/api/uploads', async ({ req, res, user }) => {
    const body = await readJson(req);
    const kind = body.kind === 'audio' ? 'audio' : 'video';
    if (!canAdd(user, kind)) throw bad(kind === 'audio' ? 'Владелец отключил добавление музыки друзьями' : 'Загружать фильмы может только владелец', 403);
    sendJson(res, 200, await uploads.beginUpload(user, { ...body, kind }));
  });

  route('PUT', '/api/uploads/:id/:index', async ({ req, res, params, user }) => {
    sendJson(res, 200, await uploads.writeChunk(user, params.id, params.index, req));
  });

  route('POST', '/api/uploads/:id/complete', async ({ res, params, user }) => {
    const mediaId = await uploads.completeUpload(user, params.id);
    enqueueIngest(mediaId);
    sendJson(res, 200, { mediaId });
  });

  route('DELETE', '/api/uploads/:id', async ({ res, params, user }) => {
    await uploads.cancelUpload(user, params.id);
    sendJson(res, 200, { ok: true });
  });

  // ── Комнаты ─────────────────────────────────────────────────────────────
  route('GET', '/api/rooms', async ({ res }) => sendJson(res, 200, { list: roomsSummary() }));

  route('POST', '/api/rooms', async ({ req, res, user }) => {
    const body = await readJson(req);
    const r = openRoom(String(body.mediaId || ''), user);
    if (r.error) throw bad(r.error);
    sendJson(res, 200, r);
  }, { auth: 'owner' });

  route('GET', '/api/rooms/for/:mediaId', async ({ res, params }) => sendJson(res, 200, { room: roomFor(params.mediaId) }));

  // ── Запасной канал живых событий ────────────────────────────────────────
  route('GET', '/api/rt/stream', async ({ req, res, user }) => hub.sseOpen(req, res, user));
  route('POST', '/api/rt/send', async ({ req, res, user }) => {
    const body = await readJson(req, 300_000);
    if (!hub.sseSend(user, String(body.cid || ''), body.msgs)) throw bad('Соединение потеряно', 410);
    sendJson(res, 200, { ok: true });
  });

  // ── Файлы: только вошедшим, доступ проверяется на каждый запрос ─────────
  route('GET', '/media/:id/:file', async ({ req, res, params }) => {
    if (!/^[A-Za-z0-9_-]{6,24}$/.test(params.id) || !/^[a-z0-9_]{1,24}\.(mp4|m4a|mp3|flac|vtt|jpg)$/.test(params.file)) throw new HttpError(404, 'Не найдено');
    const cache = params.file.endsWith('.jpg') ? 'private, max-age=604800' : 'private, max-age=3600';
    const file = path.join(DIRS.media, params.id, params.file);
    if (ACCEL) { // доступ проверили мы, а сам файл отдаст nginx (быстрее и с Range)
      try { if (!(await fs.promises.stat(file)).isFile()) throw new Error('not a file'); } catch { throw new HttpError(404, 'Файл не найден'); }
      res.writeHead(200, { 'X-Accel-Redirect': `${ACCEL}${params.id}/${params.file}`, 'content-type': mime(file), 'cache-control': cache });
      return res.end();
    }
    await sendFile(req, res, file, { cache });
  });

  // Корневой сертификат для режима https — чтобы при желании установить его на телефон.
  route('GET', '/api/ca.crt', async ({ req, res }) => {
    await sendFile(req, res, path.join(DIRS.certs, 'ca.crt'), { type: 'application/x-x509-ca-cert' });
  }, { auth: false });

  // ── Только для автопроверки (включается переменной LOZHA_DEV_TOKEN) ─────
  if (DEV_TOKEN) {
    const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    route('GET', '/dev/login', async ({ req, res, url }) => {
      if (!same(String(url.searchParams.get('token') || ''), DEV_TOKEN)) throw new HttpError(403, 'Нельзя');
      const who = url.searchParams.get('as');
      const u = who ? sql('SELECT * FROM users WHERE login_key = ?').get(auth.loginKey(who)) : sql("SELECT * FROM users WHERE role = 'owner'").get();
      if (!u) throw new HttpError(404, 'Нет такого пользователя');
      const to = url.searchParams.get('to') || '/';
      res.writeHead(302, { 'set-cookie': auth.sessionCookie(req, auth.createSession(u.id, 'dev')), location: to.startsWith('/') ? to : '/' });
      res.end();
    }, { auth: false });
    route('POST', '/api/dev/report', async ({ req, res, user }) => {
      const body = await readJson(req, 200_000);
      log(`ОТЧЁТ ПЛЕЕРА [${user.name}]`, JSON.stringify(body));
      sendJson(res, 200, { ok: true });
    });
  }
}
