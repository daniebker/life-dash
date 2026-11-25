import "../parsers.js";
import { tx, now } from "./db.mjs";
import { sha256 } from "./crypto.mjs";

const P = globalThis.LifeParsers;

export class UploadError extends Error {}

/* Each record kind has a natural key. A record whose key already exists is never inserted again;
   if its other fields differ (e.g. a running time entry that has since ended) it is updated in place. */
function prepare(db) {
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

function counter() {
  const c = { added: 0, updated: 0, unchanged: 0, removed: 0 };
  c.track = (ins, upd) => { if (ins.changes) c.added++; else if (upd && upd().changes) c.updated++; else c.unchanged++; };
  return c;
}

/* Store Oura collections for a user. Used by uploads (uploadId set) and by the background sync (uploadId null). */
export function storeOura(db, userId, collections, uploadId = null, st = prepare(db)) {
  const c = counter(), t = now();
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
const ts = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : 0; };
export function storeMindwtr(db, userId, parsed, { uploadId = null, snapshot = false } = {}) {
  const c = counter(), t = now(), seen = new Set();
  const get = db.prepare("SELECT updated_at, deleted, data FROM mindwtr_records WHERE user_id = ? AND collection = ? AND record_id = ?");
  const ins = db.prepare("INSERT INTO mindwtr_records (user_id, collection, record_id, updated_at, deleted, data, upload_id, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const upd = db.prepare("UPDATE mindwtr_records SET updated_at = ?, deleted = ?, data = ?, stored_at = ? WHERE user_id = ? AND collection = ? AND record_id = ?");
  for (const k of P.MINDWTR_KEYS) {
    for (const r of parsed[k] || []) {
      seen.add(k + "\0" + r.id);
      const data = JSON.stringify(r), deleted = r.deletedAt || r.purgedAt ? 1 : 0, updatedAt = String(r.updatedAt || "");
      const ex = get.get(userId, k, r.id);
      if (!ex) { ins.run(userId, k, r.id, updatedAt, deleted, data, uploadId, t); c.added++; }
      else if (ex.data === data && ex.deleted === deleted) c.unchanged++;
      else if (!snapshot && ts(updatedAt) < ts(ex.updated_at)) c.unchanged++; // stored copy is newer
      else { upd.run(updatedAt, deleted, data, t, userId, k, r.id); c.updated++; }
    }
  }
  if (snapshot) {
    const markDeleted = db.prepare("UPDATE mindwtr_records SET deleted = 1, stored_at = ? WHERE id = ?");
    for (const row of db.prepare("SELECT id, collection, record_id FROM mindwtr_records WHERE user_id = ? AND deleted = 0").all(userId)) {
      if (!seen.has(row.collection + "\0" + row.record_id)) { markDeleted.run(t, row.id); c.removed++; }
    }
  }
  return c;
}

/* Parse and store one uploaded file. Returns { duplicate, upload } where upload has the per-record counts. */
export function ingestUpload(db, userId, { filename, body, lastModified, tzOffsetSec }) {
  const hash = sha256(body);
  const existing = db.prepare("SELECT id, filename, kind, size, created_at, added, updated, unchanged FROM uploads WHERE user_id = ? AND sha256 = ?").get(userId, hash);
  if (existing) return { duplicate: true, upload: existing };

  const kind = P.detect(filename, body);
  if (!kind) throw new UploadError(`Couldn't recognise ${filename}. Expected a time log, check-ins, habits, activity list or Oura JSON file.`);

  const text = kind === "habits" ? null : new TextDecoder().decode(body);
  let parsed;
  try {
    if (kind === "log") parsed = P.parseLog(text, tzOffsetSec);
    else if (kind === "checkins") parsed = P.parseCheckins(text);
    else if (kind === "activities") parsed = P.parseActivities(text);
    else if (kind === "habits") parsed = P.parseHabits(body, new Date(lastModified || Date.now()).getUTCFullYear());
    else if (kind === "oura") parsed = P.ouraCollections(JSON.parse(text));
    else if (kind === "mindwtr") parsed = P.parseMindwtr(JSON.parse(text.replace(/^\uFEFF/, "")));
  } catch (e) {
    throw new UploadError(`${filename} looks like a ${kind} file but couldn't be read: ${e.message}`);
  }

  return tx(db, () => {
    // Mindwtr files are stored without their settings, which can contain API keys.
    const content = kind === "mindwtr" ? Buffer.from(JSON.stringify(parsed)) : body;
    const up = db.prepare("INSERT INTO uploads (user_id, filename, kind, sha256, size, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(userId, filename, kind, hash, body.length, content, now());
    const uploadId = Number(up.lastInsertRowid);
    const st = prepare(db);
    let c = counter();
    if (kind === "log") for (const r of parsed) c.track(st.entryIns.run(userId, r.s, r.e, r.act, uploadId), () => st.entryUpd.run(r.e, userId, r.s, r.act, r.e));
    else if (kind === "checkins") for (const r of parsed) c.track(st.chkIns.run(userId, r.t, r.core, r.mid, r.leaf, uploadId));
    else if (kind === "activities") for (const a of parsed) c.track(st.actIns.run(userId, a, uploadId));
    else if (kind === "habits") {
      for (const h of parsed) {
        const hid = st.habitUpsert.get(userId, h.name, h.target).id;
        for (const [day, v] of Object.entries(h.days)) c.track(st.dayIns.run(hid, day, v, uploadId), () => st.dayUpd.run(v, hid, day, v));
      }
    } else if (kind === "oura") c = storeOura(db, userId, parsed, uploadId, st);
    else if (kind === "mindwtr") c = storeMindwtr(db, userId, parsed, { uploadId });
    db.prepare("UPDATE uploads SET added = ?, updated = ?, unchanged = ? WHERE id = ?").run(c.added, c.updated, c.unchanged, uploadId);
    return { duplicate: false, upload: db.prepare("SELECT id, filename, kind, size, created_at, added, updated, unchanged FROM uploads WHERE id = ?").get(uploadId) };
  });
}

/* Everything the dashboard needs, in the same shape the page builds from local files. */
export function userData(db, userId) {
  const log = db.prepare("SELECT start_s AS s, end_s AS e, activity AS act FROM time_entries WHERE user_id = ? ORDER BY start_s").all(userId);
  const checkins = db.prepare("SELECT at_s AS t, core, mid, leaf FROM checkins WHERE user_id = ? ORDER BY at_s").all(userId);
  const activities = db.prepare("SELECT name FROM activities WHERE user_id = ? ORDER BY rowid").all(userId).map(r => r.name);
  const habits = db.prepare("SELECT id, name, target FROM habits WHERE user_id = ? ORDER BY id").all(userId).map(h => {
    const days = {};
    for (const d of db.prepare("SELECT day, value FROM habit_days WHERE habit_id = ?").all(h.id)) days[d.day] = d.value;
    return { name: h.name, target: h.target, days };
  });
  const oura = {};
  for (const r of db.prepare("SELECT collection, data FROM oura_records WHERE user_id = ? ORDER BY day").all(userId)) (oura[r.collection] ||= []).push(JSON.parse(r.data));
  const mw = {};
  for (const r of db.prepare("SELECT collection, data FROM mindwtr_records WHERE user_id = ? AND deleted = 0 ORDER BY id").all(userId)) (mw[r.collection] ||= []).push(JSON.parse(r.data));
  return { log, checkins, habits, activities, oura: Object.keys(oura).length ? [oura] : [], mindwtr: Object.keys(mw).length ? [P.slimMindwtr(mw)] : [] };
}
