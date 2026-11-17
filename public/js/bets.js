// Вкладка «Ставки» в комнате: твои очки, ставка (её создаёт и решает владелец) и таблица очков.
import { h, kids } from './util.js';
import { store, bus, rt } from './api.js';
import { toast, sheet, promptDialog, confirmDialog, avatar } from './ui.js';

const MIN_STAKE = 5;
const CHIPS = [5, 10, 25, 50];
const STATUS = { open: 'идёт приём ставок', closed: 'приём закрыт', resolved: 'итог', cancelled: 'отменена' };
const sign = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

export function betsPane({ openTab } = {}) {
  const isOwner = () => store.me?.role === 'owner';
  let bet = null;
  let pick = null; // вариант, который выбран для ставки (0 или 1)
  let board = [];

  const balanceEl = h('b.num', String(store.points || 0));
  const head = h('div.bets-me',
    h('div', h('div.small.faint', 'Твои очки'), balanceEl),
    h('div.small.faint.bets-rule', '+10 очков за каждые 10 минут просмотра'));
  const card = h('div.bets-card');
  const boardEl = h('div.bets-board');

  // Поле ставки создаём один раз, чтобы чужая ставка не сбрасывала то, что ты вводишь.
  const amount = h('input.input.num', { type: 'number', min: MIN_STAKE, step: 5, value: 10, inputMode: 'numeric', 'aria-label': 'Сколько очков поставить' });
  const chips = h('div.bet-chips',
    CHIPS.map((n) => h('button.chip', { type: 'button', onclick: () => { amount.value = n; } }, n)),
    h('button.chip', { type: 'button', onclick: () => { amount.value = store.points || 0; } }, 'Всё'));
  const go = h('button.btn.btn-primary', { type: 'button', onclick: () => place() }, 'Поставить');

  function place() {
    const mine = bet?.mine;
    const opt = mine ? mine.opt : pick;
    const n = Math.floor(Number(amount.value));
    if (opt == null) return toast('Выбери вариант');
    if (!Number.isFinite(n) || n < MIN_STAKE) return toast(`Минимальная ставка — ${MIN_STAKE} очков`);
    if (n > (store.points || 0)) return toast('Не хватает очков');
    rt.send({ t: 'bet:stake', opt, amount: n });
  }

  async function create() {
    const r = await promptDialog({
      title: 'Новая ставка',
      ok: 'Создать',
      fields: [
        { key: 'question', label: 'Вопрос', placeholder: 'Например: кто умрёт?', max: 120 },
        { key: 'a', label: 'Первый вариант', placeholder: 'Герой', max: 40 },
        { key: 'b', label: 'Второй вариант', placeholder: 'Злодей', max: 40 },
      ],
    });
    if (!r) return;
    if (!r.question || !r.a || !r.b) return toast('Нужны вопрос и два варианта');
    rt.send({ t: 'bet:create', question: r.question, a: r.a, b: r.b });
  }

  function chooseWinner() {
    const s = sheet({
      title: 'Что произошло?',
      body: h('div.bet-win', [
        h('p.muted', { style: { margin: '0 0 6px' } }, bet.question),
        ...bet.options.map((name, i) => h('button.btn.btn-l', {
          type: 'button',
          onclick: () => { s.close(); rt.send({ t: 'bet:resolve', opt: i }); },
        }, name)),
      ]),
    });
  }

  function optionButton(i) {
    const total = bet.totals[0] + bet.totals[1];
    const share = total ? (bet.totals[i] / total) * 100 : 0;
    const people = bet.stakes.filter((s) => s.opt === i).length;
    const mine = bet.mine?.opt === i;
    const locked = bet.status !== 'open' || (bet.mine && !mine);
    const cls = ['bet-opt', (pick === i || mine) && bet.status === 'open' ? 'sel' : '', bet.status === 'resolved' && bet.winner === i && !bet.refund ? 'won' : ''].filter(Boolean).join('.');
    return h(`button.${cls}`, {
      type: 'button', disabled: locked, 'aria-pressed': String(pick === i || mine),
      onclick: () => { pick = i; draw(); },
    },
    h('div.bet-opt-name', bet.options[i]),
    h('div.small.faint.num', `банк ${bet.totals[i]} · ${people} чел.`),
    h('div.bet-bar', h('i', { style: { width: `${share}%` } })));
  }

  function ownerButtons() {
    if (!isOwner()) return null;
    if (!bet || bet.status === 'resolved' || bet.status === 'cancelled') {
      return h('div.bet-actions', h('button.btn.btn-primary', { type: 'button', onclick: create }, bet ? 'Новая ставка' : 'Создать ставку'));
    }
    return h('div.bet-actions',
      bet.status === 'open' ? h('button.btn', { type: 'button', onclick: () => rt.send({ t: 'bet:close' }) }, 'Закрыть приём') : null,
      h('button.btn.btn-primary', { type: 'button', onclick: chooseWinner }, 'Итог…'),
      h('button.btn.btn-ghost', {
        type: 'button',
        onclick: async () => { if (await confirmDialog({ title: 'Отменить ставку?', text: 'Все поставленные очки вернутся участникам.', ok: 'Отменить ставку' })) rt.send({ t: 'bet:cancel' }); },
      }, 'Отменить'));
  }

  function result() {
    if (bet.status === 'cancelled') return h('div.bet-note', 'Ставка отменена, очки вернулись.');
    if (bet.status !== 'resolved') return null;
    const mine = bet.stakes.find((s) => s.id === store.me.id);
    const net = mine ? mine.got - mine.amount : null;
    return h('div.bet-note.res',
      bet.refund ? 'Очки возвращены: на другой вариант никто не поставил.' : `Победило: «${bet.options[bet.winner]}»`,
      net != null && !bet.refund ? h('b.num', { class: net > 0 ? 'up' : 'down' }, ` · у тебя ${sign(net)}`) : null);
  }

  function draw() {
    if (!bet) {
      card.replaceChildren(...kids(
        h('div.bet-empty', isOwner() ? 'Ставок пока нет. Придумай вопрос по фильму, например «Кто умрёт?», и друзья смогут поставить очки.' : 'Владелец ещё не создал ставку.'),
        ownerButtons()));
      return;
    }
    const open = bet.status === 'open';
    if (bet.mine) pick = bet.mine.opt;
    const form = open ? h('div.bet-form',
      bet.mine ? h('div.small.faint', `Ты поставил ${bet.mine.amount} на «${bet.options[bet.mine.opt]}». Можно добавить ещё.`) : h('div.small.faint', 'Выбери вариант и сколько очков поставить.'),
      h('div.bet-row', amount, go), chips) : null;
    card.replaceChildren(...kids(
      h('div.bet-head', h('span.chip.dim', STATUS[bet.status] || ''), h('div.bet-q', bet.question)),
      h('div.bet-opts', optionButton(0), optionButton(1)),
      form,
      bet.status === 'closed' ? h('div.bet-note', 'Приём ставок закрыт. Ждём итог.') : null,
      result(),
      bet.stakes.length ? h('div.bet-stakes', bet.stakes.map((s) => h('div.bet-stake',
        h('span.clip', s.name, s.id === store.me.id ? ' (ты)' : ''),
        h('span.small.faint.clip', `«${bet.options[s.opt]}»`),
        h('b.num', s.got == null ? String(s.amount) : sign(s.got - s.amount))))) : null,
      ownerButtons()));
  }

  function drawBoard() {
    // Показываем только тех, кто участвует в текущей ставке; пока ставок нет, блока нет.
    const inBet = new Set((bet?.stakes || []).map((s) => s.id));
    const shown = board.filter((u) => inBet.has(u.id));
    boardEl.hidden = !shown.length;
    boardEl.replaceChildren(...kids(
      h('div.bets-title', 'Очки участников'),
      shown.map((u) => h(`div.bets-row${u.id === store.me.id ? '.me' : ''}`,
        avatar(u, 's'), h('span.clip', u.name, u.id === store.me.id ? ' (ты)' : ''), h('b.num', String(u.balance))))));
  }

  // Что пришло от сервера
  function setBet(next, { quiet = false } = {}) {
    const prev = bet;
    if (!prev || !next || prev.id !== next.id) pick = null;
    bet = next;
    draw();
    drawBoard();
    if (quiet || !next) return;
    if (next.status === 'open' && (!prev || prev.id !== next.id) && !isOwner()) { // создателю напоминать о его же ставке не нужно
      toast(`Новая ставка: ${next.question}`, { action: openTab ? { label: 'Открыть', fn: openTab } : null, timeout: 8000 });
    }
    if (next.status === 'resolved' && prev && prev.id === next.id && prev.status !== 'resolved') {
      toast(next.refund ? 'Ставка закончилась, очки возвращены' : `Ставка: победило «${next.options[next.winner]}»`);
    }
    if (next.status === 'cancelled' && prev && prev.id === next.id && prev.status !== 'cancelled') toast('Ставку отменили, очки вернулись');
  }

  const askBoard = () => rt.send({ t: 'points:board' });
  let askTimer = null;
  const askSoon = () => { clearTimeout(askTimer); askTimer = setTimeout(askBoard, 1200); };
  const offs = [
    bus.on('points', (m) => {
      balanceEl.textContent = String(m.balance);
      if (m.delta > 0 && m.reason === 'watch') toast(`+${m.delta} очков за просмотр`);
      else if (m.delta > 0 && m.reason === 'bet_win') toast(`Выигрыш: +${m.delta} очков`);
      askSoon();
    }),
    bus.on('points:board', (m) => { board = m.list || []; drawBoard(); }),
    bus.on('rt:hello', askBoard),
  ];
  const timer = setInterval(askBoard, 30000);

  draw();
  drawBoard();
  if (rt.open) askBoard();

  return {
    el: h('div.bets', head, card, boardEl),
    setBet,
    destroy() { clearInterval(timer); clearTimeout(askTimer); for (const off of offs) off(); },
  };
}
