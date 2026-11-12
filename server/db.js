import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA } from './config.js';

export const db = new DatabaseSync(path.join(DATA, 'lozha.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  login_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'friend',
  avatar TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by INTEGER,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  stage TEXT,
  error TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  duration REAL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  vcodec TEXT,
  acodec TEXT,
  file TEXT,
  poster INTEGER NOT NULL DEFAULT 0,
  origin TEXT,
  job TEXT,
  added_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  q INTEGER NOT NULL,
  label TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  codec TEXT,
  codec_str TEXT,
  file TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  bitrate INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  origin TEXT,
  job TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS variants_media ON variants(media_id);
CREATE TABLE IF NOT EXISTS subtitles (
  id INTEGER PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  lang TEXT,
  label TEXT,
  file TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL DEFAULT 0,
  chunk_size INTEGER NOT NULL,
  chunks BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

const cache = new Map();
export function sql(text) {
  let s = cache.get(text);
  if (!s) { s = db.prepare(text); cache.set(text, s); }
  return s;
}

export function getSetting(key, def = null) {
  const r = sql('SELECT value FROM settings WHERE key = ?').get(key);
  if (!r) return def;
  try { return JSON.parse(r.value); } catch { return def; }
}

export function setSetting(key, value) {
  sql('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
