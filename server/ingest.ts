import * as P from "../shared/parsers.ts";
import type { Counts, UploadResult, UploadRow } from "../shared/api.ts";
import { type Db, tx, now, one, all, run } from "./db.ts";
import { sha256 } from "./crypto.ts";

export class UploadError extends Error {}

type StatementResult = { changes: number | bigint };

/* Each record kind has a natural key. A record whose key already exists is never inserted again;
   if its other fields differ (e.g. a running time entry that has since ended) it is updated in place. */
function prepare(db: Db) {
  return {
    entryIns: db.prepare("INSERT INTO time_entries (user_id, start_s, end_s, activity, upload_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING"),
    entryUpd: db.prepare("UPDATE time_entries SET end_s = ? WHERE user_id = ? AND start_s = ? AND activity = ? AND end_s != ?"),
    chkIns: db.prepare("INSERT INTO checkins (user_id, at_s, core, mid, leaf, upload_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING"),
    actIns: db.prepare("INSERT INTO activities (user_id, name, upload_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"),
    habitUpsert: db.prepare("INSERT INTO habits (user_id, name, target) VALUES (?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET target = excluded.target RETURNING id"),
    dayIns: db.prepare("INSERT INTO habit_days (habit_id, day, value, upload_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING"),
    dayUpd: db.prepare("UPDATE habit_days SET value = ? WHERE habit_id = ? AND day = ? AND value != ?"),
    ouraIns: db.prepare("INSERT INTO oura_records (user_id, collection, record_key, day, data, upload_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING"),
    ouraUpd: db.prepare("UPDATE oura_records SET data = ?, day = ?, updated_at = ? WHERE user_id = ? AND collection = ? AND record_key = ? AND data != ?"),
  };
}
type Statements = ReturnType<typeof prepare>;

class Counter implements Counts {
  added = 0; updated = 0; unchanged = 0; removed = 0;
  // An insert that changed nothing means the key exists; then try the update, which only changes differing rows.
  track(ins: StatementResult, upd?: () => StatementResult): void {
    if (Number(ins.changes)) this.added++;
    else if (upd && Number(upd().changes)) this.updated++;
    else this.unchanged++;
  }
  toJSON(): Counts { return { added: this.added, updated: this.updated, unchanged: this.unchanged, removed: this.removed }; }
}

/* Store Oura collections for a user. Used by uploads (uploadId set) and by the background sync (uploadId null). */
export function storeOura(db: Db, userId: number, collections: P.OuraCollections, uploadId: number | null = null, st: Statements = prepare(db)): Counter {
  const c = new Counter(), t = now();
  for (const name of P.OURA_KEYS) {
    for (const r of collections[name] || []) {
      if (!r || !r.day) continue;
      const key = P.ouraKey(r), data = JSON.stringify(r);
      c.track(st.ouraIns.run(userId, name, key, r.day, data, uploadId, t), () => st.ouraUpd.run(data, r.day, t, userId, name, key, data));
    }
  }
  return c;
}

/* Store Mindwtr records. A record is matched by collection + id. With snapshot = true (a WebDAV sync of the
   live file), the file is the source of truth: changed records are replaced and records missing from it are
   marked deleted. Uploads (snapshot = false) never replace a stored record with an older copy, so uploading
   an old export can't undo newer changes. */
const ts = (s: string): number => { const t = Date.parse(s); return Number.isFinite(t) ? t : 0; };
export function storeMindwtr(db: Db, userId: number, parsed: P.MindwtrData, { uploadId = null, snapshot = false }: { uploadId?: number | null; snapshot?: boolean } = {}): Counter {
  const c = new Counter(), t = now(), seen = new Set<string>();
  const get = db.prepare("SELECT updated_at, deleted, data FROM mindwtr_records WHERE user_id = ? AND collection = ? AND record_id = ?");
  const ins = db.prepare("INSERT INTO mindwtr_records (user_id, collection, record_id, updated_at, deleted, data, upload_id, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const upd = db.prepare("UPDATE mindwtr_records SET updated_at = ?, deleted = ?, data = ?, stored_at = ? WHERE user_id = ? AND collection = ? AND record_id = ?");
  for (const k of P.MINDWTR_KEYS) {
    for (const r of parsed[k] || []) {
      seen.add(k + "\0" + r.id);
      const data = JSON.stringify(r), deleted = r.deletedAt || r.purgedAt ? 1 : 0, updatedAt = String(r.updatedAt || "");
      const ex = get.get(userId, k, r.id) as { updated_at: string; deleted: number; data: string } | undefined;
      if (!ex) { ins.run(userId, k, r.id, updatedAt, deleted, data, uploadId, t); c.added++; }
      else if (ex.data === data && ex.deleted === deleted) c.unchanged++;
      else if (!snapshot && ts(updatedAt) < ts(ex.updated_at)) c.unchanged++; // stored copy is newer
      else { upd.run(updatedAt, deleted, data, t, userId, k, r.id); c.updated++; }
    }
  }
  if (snapshot) {
    const markDeleted = db.prepare("UPDATE mindwtr_records SET deleted = 1, stored_at = ? WHERE id = ?");
    for (const row of all<{ id: number; collection: string; record_id: string }>(db, "SELECT id, collection, record_id FROM mindwtr_records WHERE user_id = ? AND deleted = 0", userId)) {
      if (!seen.has(row.collection + "\0" + row.record_id)) { markDeleted.run(t, row.id); c.removed++; }
    }
  }
  return c;
}

const UPLOAD_COLUMNS = "id, filename, kind, size, created_at, added, updated, unchanged";

type Parsed =
  | { kind: "log"; rows: P.TimeEntry[] }
  | { kind: "checkins"; rows: P.Checkin[] }
  | { kind: "activities"; rows: string[] }
  | { kind: "habits"; rows: P.Habit[] }
  | { kind: "oura"; rows: P.OuraCollections }
  | { kind: "mindwtr"; rows: P.MindwtrData };

function parseUpload(kind: P.FileKind, body: Buffer, lastModified: number | undefined, tzOffsetSec: number): Parsed {
  const text = () => new TextDecoder().decode(body);
  switch (kind) {
    case "log": return { kind, rows: P.parseLog(text(), tzOffsetSec) };
    case "checkins": return { kind, rows: P.parseCheckins(text()) };
    case "activities": return { kind, rows: P.parseActivities(text()) };
    case "habits": return { kind, rows: P.parseHabits(body, new Date(lastModified || Date.now()).getUTCFullYear()) };
    case "oura": return { kind, rows: P.ouraCollections(JSON.parse(text())) ?? {} };
    case "mindwtr": return { kind, rows: P.parseMindwtrText(text()) };
  }
}

export interface UploadInput { filename: string; body: Buffer; lastModified?: number; tzOffsetSec: number }

/* Parse and store one uploaded file. Returns { duplicate, upload } where upload has the per-record counts. */
export function ingestUpload(db: Db, userId: number, { filename, body, lastModified, tzOffsetSec }: UploadInput): UploadResult {
  const hash = sha256(body);
  const existing = one<UploadRow>(db, `SELECT ${UPLOAD_COLUMNS} FROM uploads WHERE user_id = ? AND sha256 = ?`, userId, hash);
  if (existing) return { duplicate: true, upload: existing };

  const kind = P.detect(filename, body);
  if (!kind) throw new UploadError(`Couldn't recognise ${filename}. Expected a time log, check-ins, habits, activity list, Oura or Mindwtr JSON file.`);

  let parsed: Parsed;
  try { parsed = parseUpload(kind, body, lastModified, tzOffsetSec); }
  catch (e) { throw new UploadError(`${filename} looks like a ${kind} file but couldn't be read: ${(e as Error).message}`); }

  return tx(db, () => {
    // Mindwtr files are stored without their settings, which can contain API keys.
    const content = parsed.kind === "mindwtr" ? Buffer.from(JSON.stringify(parsed.rows)) : body;
    const up = run(db, "INSERT INTO uploads (user_id, filename, kind, sha256, size, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      userId, filename, kind, hash, body.length, content, now());
    const uploadId = Number(up.lastInsertRowid);
    const st = prepare(db);
    let c = new Counter();
    switch (parsed.kind) {
      case "log":
        for (const r of parsed.rows) c.track(st.entryIns.run(userId, r.s, r.e, r.act, uploadId), () => st.entryUpd.run(r.e, userId, r.s, r.act, r.e));
        break;
      case "checkins":
        for (const r of parsed.rows) c.track(st.chkIns.run(userId, r.t, r.core, r.mid, r.leaf, uploadId));
        break;
      case "activities":
        for (const a of parsed.rows) c.track(st.actIns.run(userId, a, uploadId));
        break;
      case "habits":
        for (const h of parsed.rows) {
          const hid = (st.habitUpsert.get(userId, h.name, h.target) as { id: number }).id;
          for (const [day, v] of Object.entries(h.days)) c.track(st.dayIns.run(hid, day, v, uploadId), () => st.dayUpd.run(v, hid, day, v));
        }
        break;
      case "oura": c = storeOura(db, userId, parsed.rows, uploadId, st); break;
      case "mindwtr": c = storeMindwtr(db, userId, parsed.rows, { uploadId }); break;
    }
    run(db, "UPDATE uploads SET added = ?, updated = ?, unchanged = ? WHERE id = ?", c.added, c.updated, c.unchanged, uploadId);
    return { duplicate: false, upload: one<UploadRow>(db, `SELECT ${UPLOAD_COLUMNS} FROM uploads WHERE id = ?`, uploadId)! };
  });
}

export const listUploads = (db: Db, userId: number): UploadRow[] =>
  all<UploadRow>(db, `SELECT ${UPLOAD_COLUMNS} FROM uploads WHERE user_id = ? ORDER BY id DESC`, userId);

/* Everything the dashboard needs, in the same shape the page builds from local files. */
export function userData(db: Db, userId: number): P.Sources {
  const log = all<P.TimeEntry>(db, "SELECT start_s AS s, end_s AS e, activity AS act FROM time_entries WHERE user_id = ? ORDER BY start_s", userId);
  const checkins = all<P.Checkin>(db, "SELECT at_s AS t, core, mid, leaf FROM checkins WHERE user_id = ? ORDER BY at_s", userId);
  const activities = all<{ name: string }>(db, "SELECT name FROM activities WHERE user_id = ? ORDER BY rowid", userId).map(r => r.name);
  const habits = all<{ id: number; name: string; target: number }>(db, "SELECT id, name, target FROM habits WHERE user_id = ? ORDER BY id", userId).map(h => {
    const days: Record<string, number> = {};
    for (const d of all<{ day: string; value: number }>(db, "SELECT day, value FROM habit_days WHERE habit_id = ?", h.id)) days[d.day] = d.value;
    return { name: h.name, target: h.target, days };
  });
  const oura: P.OuraCollections = {};
  for (const r of all<{ collection: P.OuraKey; data: string }>(db, "SELECT collection, data FROM oura_records WHERE user_id = ? ORDER BY day", userId)) (oura[r.collection] ||= []).push(JSON.parse(r.data));
  const mw: Partial<P.MindwtrData> = {};
  for (const r of all<{ collection: P.MindwtrKey; data: string }>(db, "SELECT collection, data FROM mindwtr_records WHERE user_id = ? AND deleted = 0 ORDER BY id", userId)) (mw[r.collection] ||= []).push(JSON.parse(r.data));
  return { log, checkins, habits, activities, oura: Object.keys(oura).length ? [oura] : [], mindwtr: Object.keys(mw).length ? [P.slimMindwtr(mw)] : [] };
}
