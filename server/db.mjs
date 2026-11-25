import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// node:sqlite is built into Node 22.13+; silence its one-time "experimental" warning.
const origEmit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes("SQLite is an experimental") ? undefined : origEmit.call(process, w, ...a));
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = origEmit;

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- every distinct file a user uploaded; the same bytes twice are recognised by sha256
  CREATE TABLE uploads (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    kind TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    content BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    added INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    unchanged INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, sha256)
  );

  -- records carry the upload that first added them (NULL for Oura sync)
  CREATE TABLE time_entries (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_s INTEGER NOT NULL,
    end_s INTEGER NOT NULL,
    activity TEXT NOT NULL,
    upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
    UNIQUE (user_id, start_s, activity)
  );
  CREATE TABLE checkins (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at_s INTEGER NOT NULL,
    core TEXT NOT NULL,
    mid TEXT NOT NULL,
    leaf TEXT NOT NULL,
    upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
    UNIQUE (user_id, at_s, core, mid, leaf)
  );
  CREATE TABLE activities (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, name)
  );
  CREATE TABLE habits (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target INTEGER NOT NULL,
    UNIQUE (user_id, name)
  );
  CREATE TABLE habit_days (
    habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    value INTEGER NOT NULL,
    upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
    PRIMARY KEY (habit_id, day)
  );
  CREATE TABLE oura_records (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    collection TEXT NOT NULL,
    record_key TEXT NOT NULL,
    day TEXT NOT NULL,
    data TEXT NOT NULL,
    upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, collection, record_key)
  );
  CREATE INDEX oura_records_day ON oura_records(user_id, day);

  CREATE TABLE oura_connections (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,      -- encrypted
    refresh_token TEXT,              -- encrypted
    expires_at INTEGER,
    scope TEXT,
    status TEXT NOT NULL DEFAULT 'active',   -- active | needs_reauth
    last_sync_at INTEGER,
    last_sync_day TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sync_runs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    added INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  `,
  `
  -- Mindwtr (GTD) records: tasks, projects, sections, areas. One row per record id; data is the record's JSON.
  CREATE TABLE mindwtr_records (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    collection TEXT NOT NULL,
    record_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
    stored_at INTEGER NOT NULL,
    UNIQUE (user_id, collection, record_id)
  );
  CREATE TABLE mindwtr_connections (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    username TEXT,
    password TEXT,                 -- encrypted
    etag TEXT,
    last_sync_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  `,
];

export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    tx(db, () => { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); });
  }
  return db;
}

export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

export const now = () => Math.floor(Date.now() / 1000);
