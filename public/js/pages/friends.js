// Друзья и приглашения (только владелец).
import { h, copyText } from '../util.js';
import { icon } from '../icons.js';
import { bus, get, post, del } from '../api.js';
import { toast, sheet, confirmDialog, avatar, busy } from '../ui.js';

const linkOf = (token) => `${location.origin}/invite/${token}`;
const dateOf = (ms) => new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const leftOf = (ms) => {
  const d = Math.max(0, ms - Date.now());
  const days = Math.floor(d / 86400e3);
  return days >= 1 ? `ещё ${days} дн.` : `ещё ${Math.max(1, Math.round(d / 3600e3))} ч`;
};

function showInvite(inv) {
  const url = linkOf(inv.token);
  const copy = async () => toast((await copyText(url)) ? 'Ссылка скопирована — отправь её другу' : 'Не получилось скопировать — выдели ссылку вручную');
  sheet({
    title: 'Приглашение готово',
    body: [
      h('p.muted', { style: { margin: 0 } }, 'Отправь эту ссылку другу. Она одноразовая и действует 7 дней: друг придумает логин и пароль и сразу попадёт в зал.'),
      h('div.linkbox', h('span', url), h('button.btn.btn-primary.btn-s', { type: 'button', onclick: copy }, icon('copy', 'ic-s'), 'Скопировать')),
    ],
  });
  copy();
}

export function friendsPage(root) {
  root.classList.add('narrow');
  const invites = h('div.list');
  const people = h('div.list', Array.from({ length: 3 }, () => h('div.skeleton', { style: { height: '64px' } })));
  const inviteBtn = h('button.btn.btn-primary', {
    type: 'button',
    onclick: async () => {
      busy(inviteBtn, true);
      try { const inv = await post('/api/invites'); await load(); showInvite(inv); } catch (e) { toast(e.message); } finally { busy(inviteBtn, false); }
    },
  }, icon('mail', 'ic-s'), h('span', 'Пригласить'));
  const invGroup = h('div.group', { hidden: true }, h('div.eyebrow', 'Приглашения, которые ещё не использованы'), invites);
  root.append(
    h('header.page-head', h('div', h('div.eyebrow', 'круг своих'), h('h1.h1', 'Друзья')), h('div.page-tools', inviteBtn)),
    invGroup,
    h('div.group', h('div.eyebrow', 'Кто в зале'), people));

  async function load() {
    let data;
    try { data = await get('/api/friends'); } catch (e) { toast(e.message); return; }
    invGroup.hidden = !data.invites.length;
    invites.replaceChildren(...data.invites.map((inv, i) => h('div.item', { style: { '--i': i } },
      icon('link'),
      h('div.grow', h('b.clip', { style: { fontFamily: 'var(--mono)', fontSize: 'var(--fs-s)' } }, linkOf(inv.token).replace(/^https?:\/\//, '')), h('span', `создано ${dateOf(inv.createdAt)} · ${leftOf(inv.expiresAt)}`)),
      h('button.btn.btn-s', { type: 'button', onclick: async () => toast((await copyText(linkOf(inv.token))) ? 'Ссылка скопирована' : 'Не получилось скопировать') }, icon('copy', 'ic-s'), h('span', 'Копировать')),
      h('button.btn.btn-ghost.btn-icon.btn-s', { type: 'button', title: 'Отозвать приглашение', onclick: async () => { await del(`/api/invites/${inv.token}`).catch(() => {}); load(); } }, icon('x', 'ic-s')))));
    const friends = data.friends.filter((f) => f.role !== 'owner');
    people.replaceChildren(...data.friends.map((f, i) => {
      const a = avatar(f);
      a.append(h(`span.dot${f.online ? '' : '.off'}`));
      return h('div.item', { style: { '--i': i } }, a,
        h('div.grow', h('b.clip', f.name), h('span', [f.role === 'owner' ? 'владелец' : `логин: ${f.login}`, f.online ? 'сейчас онлайн' : 'не в сети', `с ${dateOf(f.createdAt)}`].join(' · '))),
        f.role === 'owner' ? h('span.chip', icon('crown', 'ic-s'), 'это ты') : h('button.btn.btn-ghost.btn-icon.btn-s', {
          type: 'button', title: 'Удалить друга',
          onclick: async () => {
            if (!(await confirmDialog({ title: `Удалить ${f.name}?`, text: 'Аккаунт удалится, и друг сразу выйдет на всех устройствах. Вернуться можно будет только по новому приглашению.', ok: 'Удалить' }))) return;
            try { await del(`/api/friends/${f.id}`); toast('Аккаунт удалён'); load(); } catch (e) { toast(e.message); }
          },
        }, icon('trash', 'ic-s')));
    }));
    if (!friends.length) people.append(h('div.empty', { style: { padding: '5vh 20px' } }, icon('users'), h('p', 'Друзей пока нет. Нажми «Пригласить» и отправь ссылку — по ней можно зарегистрироваться один раз.')));
  }

  const offs = [bus.on('presence', load), bus.on('friends', load)];
  load();
  return () => { for (const off of offs) off(); };
}
