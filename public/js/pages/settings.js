// Профиль и настройки. У владельца — ещё и сервер: место на диске, yt-dlp, cookies.txt.
import { h, fmtBytes } from '../util.js';
import { icon } from '../icons.js';
import { store, bus, get, post, put, del, loadMe } from '../api.js';
import { seg, toast, confirmDialog, avatar, busy, alertBox } from '../ui.js';

async function shrinkAvatar(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = new Image();
    await new Promise((res, rej) => { im.onload = res; im.onerror = () => rej(new Error('Не получилось прочитать картинку')); im.src = url; });
    const size = 320;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const s = Math.min(im.naturalWidth, im.naturalHeight);
    c.getContext('2d').drawImage(im, (im.naturalWidth - s) / 2, (im.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Не получилось сжать картинку'))), 'image/jpeg', 0.88));
  } finally { URL.revokeObjectURL(url); }
}

export function settingsPage(root) {
  root.classList.add('narrow');
  const owner = store.me.role === 'owner';
  const setMe = (user) => { store.me = user; bus.emit('me'); drawProfile(); };

  // ── Профиль ─────────────────────────────────────────────────────────────
  const ava = h('div');
  const nameInput = h('input.input', { maxLength: 40, autocomplete: 'nickname' });
  const pick = h('input', { type: 'file', accept: 'image/*', hidden: true });
  pick.addEventListener('change', async () => {
    const f = pick.files[0];
    pick.value = '';
    if (!f) return;
    try {
      const blob = await shrinkAvatar(f);
      const r = await put('/api/profile/avatar', blob, { raw: true, type: 'image/jpeg' });
      setMe(r.user);
      toast('Аватар обновлён');
    } catch (e) { toast(e.message); }
  });
  const saveName = h('button.btn.btn-primary', { type: 'submit' }, h('span', 'Сохранить'));
  const nameForm = h('form.row.wrap', {
    onsubmit: async (e) => {
      e.preventDefault();
      busy(saveName, true);
      try { const r = await post('/api/profile', { name: nameInput.value }); setMe(r.user); toast('Имя сохранено'); } catch (err) { toast(err.message); } finally { busy(saveName, false); }
    },
  }, h('div.grow', { style: { minWidth: '200px' } }, nameInput), saveName);
  const removeAva = h('button.btn.btn-ghost.btn-s', { type: 'button', onclick: async () => { try { const r = await del('/api/profile/avatar'); setMe(r.user); } catch (e) { toast(e.message); } } }, 'Убрать фото');
  function drawProfile() {
    ava.replaceChildren(avatar(store.me, 'xl'));
    nameInput.value = store.me.name;
    removeAva.hidden = !store.me.avatar;
  }
  drawProfile();

  // ── Пароль ──────────────────────────────────────────────────────────────
  const cur = h('input.input', { type: 'password', autocomplete: 'current-password', placeholder: 'Текущий пароль', required: true });
  const next = h('input.input', { type: 'password', autocomplete: 'new-password', placeholder: 'Новый пароль — от 8 символов', minLength: 8, required: true });
  const warn = h('div', store.warnPass ? alertBox('Сейчас стоит пароль по умолчанию. Смени его — особенно если сайт доступен из интернета.') : null);
  const pwBtn = h('button.btn.btn-primary', { type: 'submit' }, h('span', 'Сменить пароль'));
  const pwMsg = h('div');
  const pwForm = h('form.col', {
    onsubmit: async (e) => {
      e.preventDefault();
      busy(pwBtn, true);
      pwMsg.replaceChildren();
      try {
        await post('/api/profile/password', { current: cur.value, next: next.value }, { quiet: true });
        cur.value = next.value = '';
        toast('Пароль изменён. На других устройствах нужно войти заново.');
        loadMe().then(() => warn.replaceChildren()).catch(() => {});
      } catch (err) { pwMsg.replaceChildren(alertBox(err.message)); } finally { busy(pwBtn, false); }
    },
  }, cur, next, pwMsg, h('div', pwBtn));

  const themeSeg = seg([{ value: 'auto', label: 'Авто', icon: 'auto' }, { value: 'dark', label: 'Тёмная', icon: 'moon' }, { value: 'light', label: 'Светлая', icon: 'sun' }],
    window.__theme.get(), (v) => { window.__theme.set(v); bus.emit('theme'); });
  const offTheme = bus.on('theme', () => themeSeg.set(window.__theme.get()));

  const logout = async (all) => {
    if (all && !(await confirmDialog({ title: 'Выйти на всех устройствах?', text: 'Все сеансы завершатся, включая этот. Входить придётся заново.', ok: 'Выйти везде' }))) return;
    try { await post(all ? '/api/logout-all' : '/api/logout'); } catch {}
    bus.emit('logout');
  };

  root.append(
    h('header.page-head', h('div', h('div.eyebrow', owner ? 'ты здесь главный' : 'твой профиль'), h('h1.h1', owner ? 'Настройки' : 'Профиль'))),
    h('div.group', h('div.eyebrow', 'Профиль'),
      h('div.card',
        h('div.row.wrap', { style: { gap: '18px' } }, ava, h('div.col', { style: { gap: '8px' } },
          h('div', h('b', store.me.login), h('span.muted', ` · ${owner ? 'владелец' : 'друг'}`)),
          h('div.row.wrap', h('button.btn.btn-s', { type: 'button', onclick: () => pick.click() }, icon('image', 'ic-s'), 'Сменить фото'), removeAva))),
        pick,
        h('label.field', h('span', 'Имя, которое видят в чате и в комнатах'), nameForm))),
    h('div.group', h('div.eyebrow', 'Оформление'), h('div.card', h('div.kv', h('span', 'Тема · «Авто» — как в системе'), themeSeg))),
    h('div.group', h('div.eyebrow', 'Пароль'), h('div.card', warn, pwForm)),
  );

  // ── Сервер (владелец) ───────────────────────────────────────────────────
  let offs = [offTheme];
  if (owner) {
    const box = h('div.col', { style: { gap: '12px' } }, h('div.skeleton', { style: { height: '120px', borderRadius: 'var(--r-l)' } }));
    root.append(h('div.group', h('div.eyebrow', 'Сервер'), box));
    const cookiePick = h('input', { type: 'file', accept: '.txt,text/plain', hidden: true });
    cookiePick.addEventListener('change', async () => {
      const f = cookiePick.files[0];
      cookiePick.value = '';
      if (!f) return;
      try { draw(await put('/api/system/cookies', await f.text(), { raw: true, type: 'text/plain' })); toast('cookies.txt загружен — yt-dlp будет использовать его'); } catch (e) { toast(e.message, { timeout: 7000 }); }
    });
    const draw = (s) => {
      const total = s.disk.used + s.disk.free;
      const upd = h('button.btn.btn-s', {
        type: 'button',
        onclick: async () => { busy(upd, true); try { draw(await post('/api/system/ytdlp-update')); toast('Проверка обновления yt-dlp завершена'); } catch (e) { toast(e.message); busy(upd, false); } },
      }, icon('refresh', 'ic-s'), h('span', 'Проверить обновление'));
      const sw = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(s.settings.friendsMusic), 'aria-label': 'Друзья могут добавлять музыку' });
      sw.onclick = async () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(on));
        try { await post('/api/system/settings', { friendsMusic: on }); } catch (e) { toast(e.message); sw.setAttribute('aria-checked', String(!on)); }
      };
      box.replaceChildren(
        h('div.card',
          h('div.kv', h('span', 'Диск'), h('b.num', `занято ${fmtBytes(s.disk.used)} · свободно ${fmtBytes(s.disk.free)}`)),
          h('div.meter', h('i', { style: { width: `${total ? Math.max(1.5, (s.disk.used / total) * 100) : 0}%` } }))),
        h('div.card',
          h('div.kv', h('span', 'yt-dlp (загрузка по ссылке)'), h('b.num', s.ytdlp.found ? `версия ${s.ytdlp.version}` : 'не установлен')),
          s.ytdlp.found ? h('div.hint', s.ytdlp.note || 'Обновляется сам: при каждом запуске сервера и раз в несколько часов.') : alertBox('Поставь yt-dlp командой  npm run setup  и перезапусти сервер.'),
          s.ytdlp.found ? h('div', upd) : null),
        h('div.card',
          h('div.kv', h('span', 'cookies.txt'), h('b', s.cookies.present ? `загружен · ${fmtBytes(s.cookies.size)}` : 'не загружен')),
          h('div.hint', 'Нужен, только если сайт пишет «нужен вход» или «подтвердите, что вы не бот». Экспортируй cookies из браузера, где ты вошёл на сайт (расширение вроде «Get cookies.txt LOCALLY»), и загрузи файл сюда — сервер передаст его yt-dlp.'),
          h('div.row.wrap', h('button.btn.btn-s', { type: 'button', onclick: () => cookiePick.click() }, icon('cookie', 'ic-s'), s.cookies.present ? 'Заменить файл' : 'Загрузить cookies.txt'),
            s.cookies.present ? h('button.btn.btn-ghost.btn-s', { type: 'button', onclick: async () => { try { draw(await del('/api/system/cookies')); } catch (e) { toast(e.message); } } }, 'Удалить') : null),
          cookiePick),
        h('div.card', h('div.kv', h('span', 'Друзья могут добавлять музыку'), sw),
          h('div.hint', 'Фильмы всегда добавляешь только ты. Музыку друзья смогут загружать файлами и по ссылке, если включено.')),
      );
    };
    get('/api/system').then(draw).catch((e) => box.replaceChildren(alertBox(e.message)));
  }

  root.append(h('div.group', h('div.eyebrow', 'Выход'),
    h('div.card', h('div.row.wrap',
      h('button.btn', { type: 'button', onclick: () => logout(false) }, icon('exit', 'ic-s'), 'Выйти'),
      h('button.btn.btn-line', { type: 'button', onclick: () => logout(true) }, 'Выйти на всех устройствах')))));

  return () => { for (const off of offs) off(); offs = []; };
}
