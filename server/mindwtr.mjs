import "../parsers.js";
import { now, tx } from "./db.mjs";
import { storeMindwtr } from "./ingest.mjs";

const P = globalThis.LifeParsers;
const MAX_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 30000;

export class MindwtrError extends Error {}

/* Accepts the WebDAV folder Mindwtr syncs to (data.json is appended) or the full address of a .json file. */
export function resolveMindwtrUrl(input) {
  let u;
  try { u = new URL(String(input || "").trim()); } catch { throw new MindwtrError("Enter the full WebDAV address, starting with https://"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new MindwtrError("The WebDAV address must start with https:// (or http:// on a local network).");
  if (u.username || u.password) throw new MindwtrError("Put the username and password in their own fields, not in the address.");
  if (/\/index\.php\/apps\/files/.test(u.pathname)) throw new MindwtrError("That's the Nextcloud web page address. Use the WebDAV address from Files → Files settings, like https://server/remote.php/dav/files/USERNAME/");
  if (!/\.json$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/?$/, "/") + "data.json";
  u.hash = "";
  return u.toString();
}

/* GET the file. Returns { unchanged: true } on 304, else { parsed, etag }. */
export async function fetchMindwtr(url, { username, password, etag } = {}) {
  const headers = { Accept: "application/json", "Accept-Encoding": "identity", "Cache-Control": "no-cache", Pragma: "no-cache" };
  if (username) headers.Authorization = "Basic " + Buffer.from(`${username}:${password ?? ""}`, "utf8").toString("base64");
  if (etag) headers["If-None-Match"] = etag;
  let res;
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) { throw new MindwtrError(e.name === "TimeoutError" ? "The WebDAV server didn't answer within 30 seconds." : `Couldn't reach the WebDAV server (${e.cause?.code || e.message}).`); }
  if (res.status === 304) return { unchanged: true, etag };
  if (res.status === 401 || res.status === 403) throw new MindwtrError(`The WebDAV server refused the username or password (HTTP ${res.status}). For Nextcloud, use an app password.`);
  if (res.status === 404) throw new MindwtrError("There's no data.json at that address. Use the folder Mindwtr syncs to, or the full address of its data.json.");
  if (!res.ok) throw new MindwtrError(`The WebDAV server answered HTTP ${res.status}.`);
  if (Number(res.headers.get("content-length")) > MAX_BYTES) throw new MindwtrError("data.json is larger than 50 MB.");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new MindwtrError("data.json is larger than 50 MB.");
  const text = buf.toString("utf8").replace(/^﻿/, "").trimStart();
  if (!text.startsWith("{")) throw new MindwtrError("data.json isn't plain JSON. If sync encryption is turned on in Mindwtr, Life Dash can't read it.");
  let json;
  try { json = JSON.parse(text); } catch { throw new MindwtrError("data.json isn't valid JSON. It may have been caught mid-write; the next sync will try again."); }
  if (!P.isMindwtr(json)) throw new MindwtrError("That file doesn't look like Mindwtr data (no tasks list).");
  return { parsed: P.parseMindwtr(json), etag: res.headers.get("etag") };
}

export function createMindwtr({ db, cfg, box, log = console }) {
  const running = new Set();
  let timer = null, nextRunAt = null;
  const connection = userId => db.prepare("SELECT * FROM mindwtr_connections WHERE user_id = ?").get(userId);

  // Test the address, store what's there, and save the connection only if that worked.
  async function connect(userId, { url, username, password }) {
    const resolved = resolveMindwtrUrl(url);
    const r = await fetchMindwtr(resolved, { username, password });
    const c = tx(db, () => {
      const counts = storeMindwtr(db, userId, r.parsed, { snapshot: true });
      db.prepare(`INSERT INTO mindwtr_connections (user_id, url, username, password, etag, last_sync_at, last_error, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
                  ON CONFLICT (user_id) DO UPDATE SET url = excluded.url, username = excluded.username, password = excluded.password,
                    etag = excluded.etag, last_sync_at = excluded.last_sync_at, last_error = NULL`)
        .run(userId, resolved, username || null, box.seal(password || ""), r.etag, now(), now());
      return counts;
    });
    return { url: resolved, added: c.added, updated: c.updated, unchanged: c.unchanged, removed: c.removed };
  }

  async function syncUser(userId) {
    if (running.has(userId)) return { skipped: true };
    const conn = connection(userId);
    if (!conn) return { skipped: true };
    running.add(userId);
    try {
      const r = await fetchMindwtr(conn.url, { username: conn.username, password: box.open(conn.password), etag: conn.etag });
      let c = { added: 0, updated: 0, unchanged: 0, removed: 0 };
      if (!r.unchanged) c = tx(db, () => storeMindwtr(db, userId, r.parsed, { snapshot: true }));
      db.prepare("UPDATE mindwtr_connections SET etag = ?, last_sync_at = ?, last_error = NULL WHERE user_id = ?").run(r.etag ?? null, now(), userId);
      if (!r.unchanged) log.info?.(`mindwtr sync user=${userId}: ${c.added} added, ${c.updated} updated, ${c.removed} removed`);
      return { unchanged: Boolean(r.unchanged), added: c.added, updated: c.updated, removed: c.removed };
    } catch (e) {
      const msg = e instanceof MindwtrError ? e.message : `Sync failed: ${e.message}`;
      db.prepare("UPDATE mindwtr_connections SET last_error = ? WHERE user_id = ?").run(msg, userId);
      log.warn?.(`mindwtr sync user=${userId} failed: ${msg}`);
      return { error: msg };
    } finally {
      running.delete(userId);
    }
  }

  async function syncAll() {
    for (const { user_id } of db.prepare("SELECT user_id FROM mindwtr_connections").all()) await syncUser(user_id);
  }

  function start() {
    if (timer) return;
    const every = Math.max(5, cfg.oura.syncIntervalMinutes) * 60 * 1000;
    nextRunAt = Date.now() + 45000;
    timer = setTimeout(function loop() {
      nextRunAt = Date.now() + every;
      syncAll().catch(e => log.error?.("mindwtr scheduler:", e)).finally(() => { timer = setTimeout(loop, every); timer.unref?.(); });
    }, 45000);
    timer.unref?.();
  }
  function stop() { clearTimeout(timer); timer = null; }

  function status(userId) {
    const c = connection(userId);
    const n = coll => db.prepare("SELECT COUNT(*) AS n FROM mindwtr_records WHERE user_id = ? AND collection = ? AND deleted = 0").get(userId, coll).n;
    return {
      connected: Boolean(c),
      url: c?.url ?? null,
      username: c?.username ?? null,
      syncing: running.has(userId),
      lastSyncAt: c?.last_sync_at ?? null,
      lastError: c?.last_error ?? null,
      nextSyncAt: c && nextRunAt ? Math.floor(nextRunAt / 1000) : null,
      tasks: n("tasks"),
      projects: n("projects"),
    };
  }

  // Stored tasks are kept; only the connection (and its password) is removed.
  function disconnect(userId) { db.prepare("DELETE FROM mindwtr_connections WHERE user_id = ?").run(userId); }

  return { connect, syncUser, syncAll, start, stop, status, disconnect };
}
