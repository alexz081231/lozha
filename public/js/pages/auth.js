// Вход и регистрация по приглашению.
import { h } from '../util.js';
import { logo } from '../icons.js';
import { bus, get, post, store } from '../api.js';
import { busy, alertBox } from '../ui.js';

function shellOf(root, ...kids) {
  root.replaceChildren(h('div.auth', h('div.auth-card', logo('auth-logo'), ...kids)));
}

export function loginPage(root) {
  const login = h('input.input', { name: 'username', autocomplete: 'username', placeholder: 'Логин', autocapitalize: 'off', required: true });
  const pass = h('input.input', { name: 'password', type: 'password', autocomplete: 'current-password', placeholder: 'Пароль', required: true });
  const btn = h('button.btn.btn-primary.btn-l.btn-block', { type: 'submit' }, h('span', 'Войти'));
  const msg = h('div');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      busy(btn, true);
      msg.replaceChildren();
      try {
        await post('/api/login', { login: login.value, password: pass.value }, { quiet: true });
        bus.emit('auth');
      } catch (err) {
        msg.replaceChildren(alertBox(err.message));
        pass.classList.add('bad');
        setTimeout(() => pass.classList.remove('bad'), 420);
        pass.select();
      } finally { busy(btn, false); }
    },
  }, login, pass, msg, btn);
  shellOf(root,
    h('div.eyebrow', 'свой маленький кинозал'),
    h('h1.h1', store.app),
    h('p', 'Фильмы и музыка вместе с друзьями. Войти можно по приглашению владельца.'),
    form);
  setTimeout(() => login.focus(), 50);
}

export async function invitePage(root, tokenValue) {
  shellOf(root, h('div.eyebrow', 'приглашение'), h('h1.h1', store.app), h('div.skeleton', { style: { height: '50px' } }), h('div.skeleton', { style: { height: '50px' } }), h('div.skeleton', { style: { height: '52px', borderRadius: '999px' } }));
  let info;
  try { info = await get(`/api/invite/${encodeURIComponent(tokenValue)}`, { quiet: true }); } catch (err) {
    shellOf(root, h('div.eyebrow', 'приглашение'), h('h1.h1', 'Не получится'), h('p', err.message), h('a.btn.btn-line.btn-l', { href: '/login' }, 'На страницу входа'));
    return;
  }
  const login = h('input.input', { name: 'username', autocomplete: 'username', placeholder: 'Логин', autocapitalize: 'off', required: true, minLength: 2, maxLength: 32 });
  const name = h('input.input', { name: 'name', autocomplete: 'nickname', placeholder: 'Имя, которое увидят друзья', maxLength: 40 });
  const pass = h('input.input', { name: 'password', type: 'password', autocomplete: 'new-password', placeholder: 'Пароль — от 8 символов', required: true, minLength: 8 });
  const btn = h('button.btn.btn-primary.btn-l.btn-block', { type: 'submit' }, h('span', 'Присоединиться'));
  const msg = h('div');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      busy(btn, true);
      msg.replaceChildren();
      try {
        await post('/api/register', { token: tokenValue, login: login.value, name: name.value, password: pass.value }, { quiet: true });
        bus.emit('auth');
      } catch (err) {
        msg.replaceChildren(alertBox(err.message));
      } finally { busy(btn, false); }
    },
  }, login, name, pass, msg, btn);
  shellOf(root,
    h('div.eyebrow', 'приглашение'),
    h('h1.h1', store.app),
    h('p', info.by ? `${info.by} зовёт тебя в свой кинозал. Придумай логин и пароль — и заходи.` : 'Придумай логин и пароль — и заходи.'),
    form,
    h('div.hint', 'Приглашение одноразовое и действует 7 дней.'));
  setTimeout(() => login.focus(), 50);
}
