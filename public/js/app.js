// Ложа: запуск, каркас (боковая панель / нижняя навигация), маршруты и переходы между страницами.
import { h, $, sleep, reduced } from './util.js';
import { icon, logo } from './icons.js';
import { store, bus, rt, loadMe, loadMedia } from './api.js';
import { toast, pill, avatar, closeOverlays } from './ui.js';
import { nav } from './nav.js';
import { mountNow } from './now.js';
import { music } from './musicplayer.js';
import { loginPage, invitePage } from './pages/auth.js';
import { libraryPage } from './pages/library.js';
import { roomPage, watchPage } from './pages/watch.js';
import { musicPage } from './pages/music.js';
import { friendsPage } from './pages/friends.js';
import { settingsPage } from './pages/settings.js';

const app = $('#app'), view = $('#view'), side = $('#side'), tabbar = $('#tabbar');

const routes = [
  { re: /^\/login\/?$/, mount: loginPage, bare: true, pub: true, name: 'login' },
  { re: /^\/invite\/([\w-]+)\/?$/, mount: invitePage, bare: true, pub: true, name: 'invite' },
  { re: /^\/$/, mount: libraryPage, nav: 'films' },
  { re: /^\/music\/?$/, mount: musicPage, nav: 'music' },
  { re: /^\/friends\/?$/, mount: friendsPage, nav: 'friends', owner: true },
  { re: /^\/settings\/?$/, mount: settingsPage, nav: 'settings' },
  { re: /^\/room\/([\w-]+)\/?$/, mount: roomPage, immersive: true },
  { re: /^\/watch\/([\w-]+)\/?$/, mount: watchPage, immersive: true },
];

// ── Каркас ────────────────────────────────────────────────────────────────
let shell = null;
function buildShell() {
  shell?.destroy();
  const me = store.me;
  const items = [
    { key: 'films', href: '/', icon: 'film', label: 'Фильмы' },
    { key: 'music', href: '/music', icon: 'music', label: 'Музыка' },
    me.role === 'owner' ? { key: 'friends', href: '/friends', icon: 'users', label: 'Друзья' } : null,
    { key: 'settings', href: '/settings', icon: 'sliders', label: me.role === 'owner' ? 'Настройки' : 'Профиль' },
  ].filter(Boolean);

  const navEl = h('nav.nav', items.map((it) => h('a', { href: it.href, dataset: { nav: it.key } }, icon(it.icon), h('span', it.label))));
  const nowList = h('div.now-list');
  const themeBtn = h('button.btn.btn-ghost.btn-icon.btn-s', { type: 'button', title: 'Тема: по системе / тёмная / светлая' });
  const paintTheme = () => themeBtn.replaceChildren(icon({ auto: 'auto', dark: 'moon', light: 'sun' }[window.__theme.get()] || 'auto', 'ic-s'));
  themeBtn.onclick = () => {
    const next = { auto: 'dark', dark: 'light', light: 'auto' }[window.__theme.get()] || 'auto';
    window.__theme.set(next);
    paintTheme();
    bus.emit('theme');
    toast({ auto: 'Тема: как в системе', dark: 'Тема: тёмная', light: 'Тема: светлая' }[next], { timeout: 1600 });
  };
  paintTheme();
  const who = h('a.who', { href: '/settings' }, h('b.clip', me.name), h('span', me.role === 'owner' ? 'владелец' : 'друг'));
  const ava = h('a', { href: '/settings' }, avatar(me));
  side.replaceChildren(
    h('a.brand', { href: '/' }, logo(), h('span', store.app)),
    navEl,
    h('section.side-now', h('div.eyebrow', 'Смотрят сейчас'), nowList),
    h('div.side-foot', ava, who, themeBtn),
  );
  side.classList.add('glass');
  tabbar.replaceChildren(...items.map((it) => h('a', { href: it.href, dataset: { nav: it.key } }, icon(it.icon), h('span', it.label))));
  tabbar.classList.add('glass');
  side.hidden = false;
  tabbar.hidden = false;

  const p1 = pill(navEl), p2 = pill(tabbar);
  const offNow = mountNow(nowList, { emptyText: me.role === 'owner' ? 'Пока никто не смотрит. Нажми «Смотреть» на фильме — друзья увидят комнату здесь.' : 'Пока никто не смотрит. Когда владелец включит фильм, комната появится здесь.' });
  const offTheme = bus.on('theme', paintTheme);
  const offMe = bus.on('me', () => {
    who.replaceChildren(h('b.clip', store.me.name), h('span', store.me.role === 'owner' ? 'владелец' : 'друг'));
    ava.replaceChildren(avatar(store.me));
  });
  shell = {
    active(key) {
      for (const a of [...navEl.querySelectorAll('a'), ...tabbar.querySelectorAll('a')]) a.classList.toggle('on', a.dataset.nav === key);
      p1.update();
      p2.update();
    },
    destroy() { p1.destroy(); p2.destroy(); offNow(); offTheme(); offMe(); },
  };
}

// ── Маршруты и плавные переходы ───────────────────────────────────────────
let current = null;
let token = 0;

async function render() {
  const path = location.pathname;
  let route = null, params = [];
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) { route = r; params = m.slice(1); break; }
  }
  if (!route) return nav.go('/', { replace: true });
  if (!store.me && !route.pub) {
    try { sessionStorage.setItem('lozha.next', path); } catch {}
    return nav.go('/login', { replace: true });
  }
  if (store.me && route.name === 'login') return nav.go('/', { replace: true });
  if (route.owner && store.me?.role !== 'owner') return nav.go('/', { replace: true });

  const my = ++token;
  closeOverlays();
  music.closeNow();
  if (current) {
    const old = current;
    current = null;
    old.el.classList.remove('in');
    old.el.classList.add('out');
    await sleep(reduced() ? 0 : 130);
    try { old.cleanup?.(); } catch (e) { console.error(e); }
    old.el.remove();
    if (my !== token) return;
  }
  app.classList.toggle('bare', !!route.bare);
  app.classList.toggle('immersive', !!route.immersive);
  shell?.active(route.nav || '');
  const el = h('div', { class: route.bare || route.immersive ? 'host' : 'page' });
  view.append(el);
  if (store.warnPass && route.nav && route.nav !== 'settings') {
    el.append(h('div.alert.warnpass', icon('key', 'ic-s'), h('div.grow', h('b', 'Пароль по умолчанию. '), 'Его легко подобрать — смени, особенно если сайт открыт из интернета.'),
      h('a.btn.btn-primary.btn-s', { href: '/settings' }, 'Сменить')));
  }
  scrollTo(0, 0);
  let cleanup = null;
  try { cleanup = await route.mount(el, ...params); } catch (e) {
    console.error(e);
    el.replaceChildren(h('div.empty', icon('warn'), h('p', 'Что-то пошло не так. Обнови страницу.')));
  }
  if (my !== token) { try { cleanup?.(); } catch {} el.remove(); return; }
  current = { el, cleanup };
  void el.offsetWidth;
  el.classList.add('in');
}
nav.render = render;

addEventListener('popstate', () => { window.__navDepth = Math.max(0, window.__navDepth - 1); render(); });
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  if (!a || a.target || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented || e.button) return;
  const href = a.getAttribute('href');
  if (!href.startsWith('/') || href.startsWith('//')) return;
  e.preventDefault();
  window.__navDepth++;
  nav.go(href);
});

// ── Сессия ────────────────────────────────────────────────────────────────
async function startSession() {
  buildShell();
  rt.start();
  try { await loadMedia(); } catch {}
}

function endSession() {
  if (!store.me) return;
  store.me = null;
  rt.stop();
  music.reset();
  shell?.destroy();
  shell = null;
  side.hidden = true;
  tabbar.hidden = true;
  nav.go('/login', { replace: true });
}

bus.on('auth', async () => {
  await loadMe();
  await startSession();
  let next = '/';
  try { next = sessionStorage.getItem('lozha.next') || '/'; sessionStorage.removeItem('lozha.next'); } catch {}
  nav.go(/^\/(login|invite)/.test(next) ? '/' : next, { replace: true });
});
bus.on('unauthorized', endSession);
bus.on('logout', endSession);
bus.on('bye', (m) => { if (store.me) toast(m.reason || 'Сессия завершена'); endSession(); });
bus.on('toast', (m) => toast(m.text, m.room ? { action: { label: 'Перейти', fn: () => nav.go(`/room/${m.room}`) } } : {}));
bus.on('perms', async () => { try { await loadMe(); bus.emit('perms:changed'); } catch {} });

// Владелец начал смотреть — зовём друзей, которые сейчас на сайте.
bus.on('notify', (m) => {
  if (m.type !== 'watch' || location.pathname === `/room/${m.room}`) return;
  toast(`${m.by} смотрит «${m.title}» — заходи`, { img: m.poster || undefined, action: { label: 'Зайти', fn: () => nav.go(`/room/${m.room}`) }, timeout: 12000 });
});

let helloCount = 0;
bus.on('rt:hello', () => { if (helloCount++ > 0) loadMedia().catch(() => {}); });

let offlineToast = null;
bus.on('rt', (open) => {
  if (!open && store.me) {
    clearTimeout(offlineToast);
    offlineToast = setTimeout(() => { if (!rt.open && store.me) toast('Связь с сервером потерялась — переподключаюсь…', { timeout: 4000 }); }, 3500);
  } else clearTimeout(offlineToast);
});

// Для отладки и автопроверок из консоли браузера.
window.__lozha = { store, rt, music, nav, bus };

(async function boot() {
  try { await loadMe(); } catch { toast('Сервер не отвечает. Попробуй обновить страницу.'); }
  if (store.me) await startSession();
  app.classList.remove('booting');
  render();
})();
