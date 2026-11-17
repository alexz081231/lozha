// Ставки в комнате: ставку создаёт и закрывает владелец, у неё два варианта, ставить может любой зритель.
// Банк делится между угадавшими пропорционально ставкам. Если угадавших или проигравших нет — все получают очки назад.
import * as hub from './hub.js';
import { sql, tx } from './db.js';
import { rid } from './util.js';
import { MIN_STAKE, balanceOf, change, tell, leaderboard } from './points.js';

const ACTIVE = ['open', 'closed'];
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const userError = (text) => Object.assign(new Error(text), { user: true });

const latest = (roomId) => sql('SELECT * FROM bets WHERE room_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(roomId);
const stakesOf = (betId) => sql(`SELECT s.user_id, s.opt, s.amount, u.name FROM bet_stakes s
  LEFT JOIN users u ON u.id = s.user_id WHERE s.bet_id = ? ORDER BY s.rowid`).all(betId);

// Кто сколько получает. Остаток от деления достаётся тому, кто поставил больше всех.
export function settle(stakes, winner) {
  const pool = stakes.reduce((a, s) => a + s.amount, 0);
  const wins = stakes.filter((s) => s.opt === winner);
  const winSum = wins.reduce((a, s) => a + s.amount, 0);
  const pay = new Map();
  if (!winSum || winSum === pool) {
    for (const s of stakes) pay.set(s.user_id, s.amount);
    return { refund: true, pay };
  }
  let paid = 0;
  for (const s of wins) { const x = Math.floor((pool * s.amount) / winSum); pay.set(s.user_id, x); paid += x; }
  const top = wins.reduce((a, b) => (b.amount > a.amount ? b : a));
  pay.set(top.user_id, pay.get(top.user_id) + (pool - paid));
  return { refund: false, pay };
}

export function betView(roomId, uid) {
  const b = latest(roomId);
  if (!b) return null;
  const stakes = stakesOf(b.id);
  const totals = [0, 0];
  for (const s of stakes) totals[s.opt] += s.amount;
  const res = b.status === 'resolved' ? settle(stakes, b.winner) : null;
  const mine = stakes.find((s) => s.user_id === uid);
  return {
    id: b.id, question: b.question, options: [b.opt_a, b.opt_b], status: b.status, winner: b.winner,
    refund: res ? res.refund : false, totals, createdAt: b.created_at,
    stakes: stakes.map((s) => ({ id: s.user_id, name: s.name || 'Бывший зритель', opt: s.opt, amount: s.amount, got: res ? res.pay.get(s.user_id) || 0 : null })),
    mine: mine ? { opt: mine.opt, amount: mine.amount } : null,
  };
}

function sendBet(room) {
  for (const m of room.members.values()) m.conn.send({ t: 'room:bet', room: room.id, bet: betView(room.id, m.conn.user.id) });
}

const filmRoom = (c) => (c.room?.kind === 'film' ? c.room : null);
const ownerOnly = (c) => {
  if (c.user.role === 'owner') return true;
  c.send({ t: 'toast', text: 'Это может только владелец' });
  return false;
};

// Выполняет действие; понятные пользователю ошибки показываем тостом, остальные пробрасываем в журнал.
function run(c, fn) {
  try { fn(); } catch (e) {
    if (!e.user) throw e;
    c.send({ t: 'toast', text: e.message });
  }
}

function createBet(c, m) {
  const room = filmRoom(c);
  if (!room || !ownerOnly(c)) return;
  run(c, () => {
    const question = clean(m.question, 120);
    const a = clean(m.a, 40);
    const b = clean(m.b, 40);
    if (!question || !a || !b) throw userError('Нужны вопрос и два варианта');
    if (a.toLowerCase() === b.toLowerCase()) throw userError('Варианты должны отличаться');
    const cur = latest(room.id);
    if (cur && ACTIVE.includes(cur.status)) throw userError('Сначала закончи текущую ставку');
    sql('INSERT INTO bets (id, room_id, question, opt_a, opt_b, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(rid(8), room.id, question, a, b, 'open', c.user.id, Date.now());
    sendBet(room);
  });
}

function stake(c, m) {
  const room = filmRoom(c);
  const mem = room?.members.get(c.id);
  if (!mem) return;
  if (room.limited(mem, 'bet', 6)) return c.send({ t: 'toast', text: 'Чуть помедленнее' });
  run(c, () => {
    const opt = m.opt === 0 || m.opt === 1 ? m.opt : null;
    const amount = Math.floor(Number(m.amount));
    if (opt == null) throw userError('Выбери вариант');
    if (!Number.isFinite(amount) || amount < MIN_STAKE) throw userError(`Минимальная ставка — ${MIN_STAKE} очков`);
    tx(() => {
      const bet = latest(room.id);
      if (!bet || bet.status !== 'open') throw userError('Приём ставок закрыт');
      const mine = sql('SELECT opt FROM bet_stakes WHERE bet_id = ? AND user_id = ?').get(bet.id, c.user.id);
      if (mine && mine.opt !== opt) throw userError('Ты уже поставил на другой вариант');
      if (amount > balanceOf(c.user.id)) throw userError('Не хватает очков');
      sql(`INSERT INTO bet_stakes (bet_id, user_id, opt, amount) VALUES (?, ?, ?, ?)
           ON CONFLICT(bet_id, user_id) DO UPDATE SET amount = amount + excluded.amount`).run(bet.id, c.user.id, opt, amount);
      change(c.user.id, -amount, 'bet_stake', bet.id);
    });
    tell(c.user.id, -amount, 'bet');
    sendBet(room);
  });
}

function closeBets(c) {
  const room = filmRoom(c);
  if (!room || !ownerOnly(c)) return;
  const b = latest(room.id);
  if (!b || b.status !== 'open') return;
  sql("UPDATE bets SET status = 'closed', closed_at = ? WHERE id = ?").run(Date.now(), b.id);
  sendBet(room);
}

function resolveBet(c, m) {
  const room = filmRoom(c);
  if (!room || !ownerOnly(c)) return;
  const winner = m.opt === 0 || m.opt === 1 ? m.opt : null;
  if (winner == null) return;
  const paid = tx(() => {
    const b = latest(room.id);
    if (!b || !ACTIVE.includes(b.status)) return null;
    const stakes = stakesOf(b.id);
    const r = settle(stakes, winner);
    for (const [uid, x] of r.pay) change(uid, x, r.refund ? 'bet_refund' : 'bet_win', b.id);
    sql("UPDATE bets SET status = 'resolved', winner = ?, closed_at = ? WHERE id = ?").run(winner, Date.now(), b.id);
    return { pay: r.pay, refund: r.refund };
  });
  if (!paid) return;
  for (const [uid, x] of paid.pay) tell(uid, x, paid.refund ? 'bet_refund' : 'bet_win');
  sendBet(room);
  room.send({ t: 'points:board', list: leaderboard() });
}

// Отмена: все ставки возвращаются.
function cancelActive(roomId) {
  const refunds = tx(() => {
    const b = latest(roomId);
    if (!b || !ACTIVE.includes(b.status)) return null;
    const stakes = stakesOf(b.id);
    for (const s of stakes) change(s.user_id, s.amount, 'bet_refund', b.id);
    sql("UPDATE bets SET status = 'cancelled', closed_at = ? WHERE id = ?").run(Date.now(), b.id);
    return stakes;
  });
  if (!refunds) return false;
  for (const s of refunds) tell(s.user_id, s.amount, 'bet_refund');
  return true;
}

function cancelBet(c) {
  const room = filmRoom(c);
  if (!room || !ownerOnly(c)) return;
  if (cancelActive(room.id)) sendBet(room);
}

// Комнату закрыли — незавершённую ставку отменяем, очки возвращаем.
export function cancelRoomBets(roomId) {
  cancelActive(roomId);
}

// После перезапуска: ставки комнат, которых уже нет, отменяем.
export function cancelOrphanBets(aliveRoomIds) {
  const ids = sql("SELECT DISTINCT room_id FROM bets WHERE status IN ('open', 'closed')").all().map((r) => r.room_id);
  for (const id of ids) if (!aliveRoomIds.has(id)) cancelActive(id);
}

export function initBets() {
  hub.on('bet:create', createBet);
  hub.on('bet:stake', stake);
  hub.on('bet:close', closeBets);
  hub.on('bet:resolve', resolveBet);
  hub.on('bet:cancel', cancelBet);
  hub.on('points:board', (c) => c.send({ t: 'points:board', list: leaderboard() }));
  hub.onOpen((c) => c.send({ t: 'points', balance: balanceOf(c.user.id), delta: 0, reason: '' }));
}
