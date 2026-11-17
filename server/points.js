// Очки: 10 очков за каждые 10 минут просмотра. Баланс и история лежат в БД.
import { sql, tx } from './db.js';
import * as hub from './hub.js';
import { publicUser } from './auth.js';

export const WATCH_BLOCK_MS = 10 * 60e3;
export const WATCH_BLOCK_POINTS = 10;
export const MIN_STAKE = 5;

const ensure = (uid) => sql('INSERT OR IGNORE INTO points (user_id, balance, watch_ms) VALUES (?, 0, 0)').run(uid);

export function balanceOf(uid) {
  return sql('SELECT balance FROM points WHERE user_id = ?').get(uid)?.balance ?? 0;
}

// Меняет баланс. Вызывать внутри tx(), чтобы баланс и история не разошлись.
export function change(uid, delta, reason, ref = null) {
  ensure(uid);
  sql('UPDATE points SET balance = balance + ? WHERE user_id = ?').run(delta, uid);
  sql('INSERT INTO points_log (user_id, delta, reason, ref, at) VALUES (?, ?, ?, ?, ?)').run(uid, delta, reason, ref, Date.now());
}

// Сообщаем человеку (на всех его устройствах) новый баланс.
export function tell(uid, delta = 0, reason = '') {
  hub.toUser(uid, { t: 'points', balance: balanceOf(uid), delta, reason });
}

// ── Очки за просмотр ──────────────────────────────────────────────────────
const pending = new Map(); // uid → накопленные миллисекунды, ещё не записанные в БД
const lastAt = new Map(); // uid → когда его засчитывали в последний раз

// Засчитываем время человеку, который смотрит. С двух вкладок или из двух комнат время не удваивается.
export function accrueWatch(uid, ms, now) {
  const eff = Math.min(ms, now - (lastAt.get(uid) || 0));
  lastAt.set(uid, now);
  if (eff <= 0) return;
  const sum = (pending.get(uid) || 0) + eff;
  pending.set(uid, sum);
  if (sum >= 15000) flushWatch(uid);
}

export function flushWatch(uid) {
  const ms = pending.get(uid);
  pending.delete(uid);
  if (!ms) return;
  const blocks = tx(() => {
    ensure(uid);
    sql('UPDATE points SET watch_ms = watch_ms + ? WHERE user_id = ?').run(Math.round(ms), uid);
    const n = Math.floor(sql('SELECT watch_ms FROM points WHERE user_id = ?').get(uid).watch_ms / WATCH_BLOCK_MS);
    if (n > 0) {
      sql('UPDATE points SET watch_ms = watch_ms - ? WHERE user_id = ?').run(n * WATCH_BLOCK_MS, uid);
      change(uid, n * WATCH_BLOCK_POINTS, 'watch');
    }
    return n;
  });
  if (blocks > 0) tell(uid, blocks * WATCH_BLOCK_POINTS, 'watch');
}

export function flushAllWatch() {
  for (const uid of [...pending.keys()]) { try { flushWatch(uid); } catch {} }
}

export function leaderboard() {
  return sql(`SELECT u.id, u.login, u.name, u.role, u.avatar, COALESCE(p.balance, 0) AS balance
              FROM users u LEFT JOIN points p ON p.user_id = u.id
              ORDER BY balance DESC, u.name COLLATE NOCASE`).all()
    .map((r) => ({ ...publicUser(r), balance: r.balance }));
}
