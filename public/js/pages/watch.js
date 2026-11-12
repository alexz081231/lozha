// Комната совместного просмотра и одиночный просмотр.
import { h, copyText, img, fmtTime } from '../util.js';
import { icon } from '../icons.js';
import { store, bus, rt, loadMedia, films } from '../api.js';
import { toast, sheet, confirmDialog } from '../ui.js';
import { nav } from '../nav.js';
import { Player } from '../player.js';
import { RoomSession, roomPanel, reactionBar, eventText } from '../room.js';
import { Voice, voiceBar } from '../voice.js';
import { music } from '../musicplayer.js';

async function ensureMedia() {
  if (!store.mediaLoaded) { try { await loadMedia(); } catch {} }
}

export async function roomPage(root, roomId) {
  root.className = 'room';
  music.leave(); // фильм и музыка одновременно не играют
  await ensureMedia();
  const owner = store.me.role === 'owner';
  let player = null;
  let closed = false;

  const leave = () => nav.go('/');
  const title = h('div.ttl.clip', 'Комната');
  const sub = h('div.sub.clip', 'подключаюсь…');
  const stage = h('div.room-stage', h('div.skeleton', { style: { width: '100%', height: '100%', borderRadius: 'var(--r-l)' } }));

  const voice = new Voice({
    onChange: () => { vbar.draw(); panel.redraw(); },
    onSpeaking: () => {
      panel.setSpeaking(new Set(voice.speaking));
      player?.setDuck(voice.othersSpeaking() ? 0.35 : 1); // пока кто-то говорит, фильм немного приглушается
    },
  });
  voice.uidOf = (cid) => session.viewers.find((v) => v.cid === cid)?.id ?? null;
  const vbar = voiceBar(voice);

  const panel = roomPanel({ onSeek: (t) => session.control('seek', t), voice });

  const session = new RoomSession(roomId, {
    getEl: () => player?.video,
    play: () => player?.play(),
    pause: () => player?.pause(),
    isSwitching: () => !!player?.switching,
    onJoined: (m) => { panel.setChat(m.chat || []); panel.setViewers(m.viewers); paintSub(); if (voice.joined) { voice.leave(true); voice.join(); } },
    onState: (s) => applyState(s),
    onViewers: (list) => { panel.setViewers(list); paintSub(); },
    onEvent: (e) => {
      if (e.type === 'join' || e.type === 'leave') { if (e.cid !== rt.cid) panel.addSys(eventText(e)); return; }
      if (e.cid === rt.cid) return;
      player?.flash(eventText(e), 2800);
    },
    onChat: (msg) => panel.addChat(msg),
    onReact: (m) => player?.react(m.emoji, m.user.id === store.me.id ? '' : m.user.name),
    onGone: (why, m) => {
      if (closed) return;
      closed = true;
      toast(why === 'closed' ? (m.by && m.by !== store.me.name ? `${m.by} закрывает комнату` : 'Комната закрыта') : 'Этой комнаты уже нет');
      nav.go('/', { replace: true });
    },
    onVoice: (m) => voice.handle(m),
    onOffline: () => { sub.textContent = 'связь потеряна — переподключаюсь…'; },
  });

  function paintSub() {
    const names = [...new Map(session.viewers.map((v) => [v.id, v.name])).values()];
    sub.textContent = names.length ? `в комнате: ${names.join(', ')}` : '';
  }

  function applyState(s) {
    const m = store.media.get(s.mediaId);
    if (!m) { sub.textContent = 'фильм недоступен'; return; }
    if (!player) {
      player = new Player({ media: m, room: true, onAction: (a, v) => session.control(a, v), onBack: leave });
      player.onMeta = () => session.tick();
      player.statExtra = () => `Рассинхрон  ${Math.round((session.drift || 0) * 1000)} мс (связь ${Math.round(rt.rtt)} мс)`;
      stage.replaceChildren(player.el);
    } else if (player.media.id !== m.id) player.setMedia(m);
    title.textContent = m.title;
    document.title = `${m.title} — ${store.app}`;
    player.roomRate = s.rate;
    player.setRoomUi({ playing: s.playing });
    const names = s.waitingFor || [];
    player.setWait(s.playing && s.waiting ? (names.length ? `Ждём: ${names.join(', ')} — видео загружается…` : 'Синхронизация…') : null);
  }

  const copyBtn = h('button.btn.btn-s', { type: 'button', title: 'Скопировать ссылку на комнату', onclick: async () => { toast((await copyText(location.href)) ? 'Ссылка на комнату скопирована' : 'Не получилось скопировать ссылку'); } }, icon('link', 'ic-s'), h('span', 'Ссылка'));
  const ownerTools = owner ? [
    h('button.btn.btn-s', { type: 'button', title: 'Сменить фильм', onclick: () => pickFilm() }, icon('swap', 'ic-s'), h('span', 'Фильм')),
    h('button.btn.btn-s.btn-icon', {
      type: 'button', title: 'Закрыть комнату',
      onclick: async () => { if (await confirmDialog({ title: 'Закрыть комнату?', text: 'Все зрители вернутся в библиотеку.', ok: 'Закрыть' })) rt.send({ t: 'room:close' }); },
    }, icon('x', 'ic-s')),
  ] : [];

  function pickFilm() {
    const list = films().filter((f) => f.status === 'ready');
    const s = sheet({
      title: 'Сменить фильм',
      body: h('div.pick-list', list.map((f) => h('button.pick', {
        type: 'button', disabled: f.id === session.state?.mediaId,
        onclick: () => { rt.send({ t: 'room:media', mediaId: f.id }); s.close(); },
      }, h('div.now-thumb', icon('film'), f.poster ? img(f.poster) : null),
      h('div', h('div.film-title', f.title), h('div.small.faint.num', `${fmtTime(f.duration)}${f.id === session.state?.mediaId ? ' · идёт сейчас' : ''}`))))),
    });
  }

  root.append(
    h('div.room-main',
      h('div.room-top', h('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': 'Назад', onclick: leave }, icon('back')),
        h('div.grow', title, sub), copyBtn, ...ownerTools),
      stage,
      h('div.room-under', reactionBar((e) => rt.send({ t: 'room:react', emoji: e })), vbar)),
    h('aside.room-side', panel.el),
  );

  const offMedia = bus.on('media', (m) => { if (player && m.id === player.media.id) player.setMedia(m); });
  session.start();
  window.__room = { session, voice, panel, get player() { return player; } };

  return () => {
    closed = true;
    window.__room = null;
    offMedia();
    voice.leave();
    session.stop();
    player?.destroy();
    document.title = store.app;
  };
}

// Друг смотрит фильм один (без комнаты). Если владелец откроет комнату — предложим зайти.
export async function watchPage(root, mediaId) {
  root.className = 'room solo';
  music.leave();
  await ensureMedia();
  const m = store.media.get(mediaId);
  const back = () => nav.go('/');
  if (!m || m.kind !== 'video') {
    root.append(h('div.room-main', h('div.empty', icon('film'), h('p', 'Такого фильма нет — возможно, его удалили.'), h('button.btn.btn-primary', { type: 'button', onclick: back }, 'В библиотеку'))));
    return () => {};
  }
  const player = new Player({ media: m, onBack: back });
  window.__room = { player };
  document.title = `${m.title} — ${store.app}`;
  root.append(h('div.room-main',
    h('div.room-top', h('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': 'Назад', onclick: back }, icon('back')),
      h('div.grow', h('div.ttl.clip', m.title), h('div.sub', 'одиночный просмотр'))),
    h('div.room-stage', player.el)));

  let offered = false;
  const offer = () => {
    const r = store.rooms.find((x) => x.mediaId === mediaId);
    if (r && !offered) {
      offered = true;
      toast('Этот фильм сейчас смотрят вместе', { action: { label: 'Зайти', fn: () => nav.go(`/room/${r.id}`) }, timeout: 10000 });
    }
  };
  const offs = [
    bus.on('media', (x) => { if (x.id === mediaId) player.setMedia(x); }),
    bus.on('media:gone', (id) => { if (id === mediaId) { toast('Фильм удалён'); back(); } }),
    bus.on('rooms', offer),
  ];
  offer();
  return () => {
    for (const off of offs) off();
    player.destroy();
    document.title = store.app;
  };
}
