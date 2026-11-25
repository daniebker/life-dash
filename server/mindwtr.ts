import * as P from "../shared/parsers.ts";
import type { MindwtrConnectResult, MindwtrStatus, MindwtrSyncResult } from "../shared/api.ts";
import type { Config } from "./config.ts";
import type { Box } from "./crypto.ts";
import { type Db, type MindwtrConnectionRow, now, tx, one, all, run } from "./db.ts";
import { storeMindwtr } from "./ingest.ts";
import type { Logger } from "./log.ts";

const MAX_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 30000;

export class MindwtrError extends Error {}

/* Accepts the WebDAV folder Mindwtr syncs to (data.json is appended) or the full address of a .json file. */
export function resolveMindwtrUrl(input: unknown): string {
  let u: URL;
  try { u = new URL(String(input || "").trim()); } catch { throw new MindwtrError("Enter the full WebDAV address, starting with https://"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new MindwtrError("The WebDAV address must start with https:// (or http:// on a local network).");
  if (u.username || u.password) throw new MindwtrError("Put the username and password in their own fields, not in the address.");
  if (/\/index\.php\/apps\/files/.test(u.pathname)) throw new MindwtrError("That's the Nextcloud web page address. Use the WebDAV address from Files → Files settings, like https://server/remote.php/dav/files/USERNAME/");
  if (!/\.json$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/?$/, "/") + "data.json";
  u.hash = "";
  return u.toString();
}

export type FetchResult = { unchanged: true; etag: string | null } | { unchanged?: false; parsed: P.MindwtrData; etag: string | null };

/* GET the file. Returns { unchanged: true } on 304, else the parsed records and the ETag. */
export async function fetchMindwtr(url: string, { username, password, etag }: { username?: string | null; password?: string | null; etag?: string | null } = {}): Promise<FetchResult> {
  const headers: Record<string, string> = { Accept: "application/json", "Accept-Encoding": "identity", "Cache-Control": "no-cache", Pragma: "no-cache" };
  if (username) headers.Authorization = "Basic " + Buffer.from(`${username}:${password ?? ""}`, "utf8").toString("base64");
  if (etag) headers["If-None-Match"] = etag;
  let res: Response;
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    throw new MindwtrError(err.name === "TimeoutError" ? "The WebDAV server didn't answer within 30 seconds." : `Couldn't reach the WebDAV server (${err.cause?.code || err.message}).`);
  }
  if (res.status === 304) return { unchanged: true, etag: etag ?? null };
  if (res.status === 401 || res.status === 403) throw new MindwtrError(`The WebDAV server refused the username or password (HTTP ${res.status}). For Nextcloud, use an app password.`);
  if (res.status === 404) throw new MindwtrError("There's no data.json at that address. Use the folder Mindwtr syncs to, or the full address of its data.json.");
  if (!res.ok) throw new MindwtrError(`The WebDAV server answered HTTP ${res.status}.`);
  if (Number(res.headers.get("content-length")) > MAX_BYTES) throw new MindwtrError("data.json is larger than 50 MB.");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new MindwtrError("data.json is larger than 50 MB.");
  const text = buf.toString("utf8").replace(/^﻿/, "").trimStart();
  if (!text.startsWith("{")) throw new MindwtrError("data.json isn't plain JSON. If sync encryption is turned on in Mindwtr, Life Dash can't read it.");
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new MindwtrError("data.json isn't valid JSON. It may have been caught mid-write; the next sync will try again."); }
  if (!P.isMindwtr(json)) throw new MindwtrError("That file doesn't look like Mindwtr data (no tasks list).");
  return { parsed: P.parseMindwtr(json), etag: res.headers.get("etag") };
}

export function createMindwtr({ db, cfg, box, log }: { db: Db; cfg: Config; box: Box; log: Logger }) {
  const running = new Set<number>();
  let timer: NodeJS.Timeout | null = null, nextRunAt: number | null = null;
  const connection = (userId: number) => one<MindwtrConnectionRow>(db, "SELECT * FROM mindwtr_connections WHERE user_id = ?", userId);

  // Test the address, store what's there, and save the connection only if that worked.
  async function connect(userId: number, { url, username, password }: { url: string; username: string; password: string }): Promise<MindwtrConnectResult> {
    const resolved = resolveMindwtrUrl(url);
    const r = await fetchMindwtr(resolved, { username, password });
    if (r.unchanged) throw new MindwtrError("The WebDAV server sent no content.");
    const c = tx(db, () => {
      const counts = storeMindwtr(db, userId, r.parsed, { snapshot: true });
      run(db, `INSERT INTO mindwtr_connections (user_id, url, username, password, etag, last_sync_at, last_error, created_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
               ON CONFLICT (user_id) DO UPDATE SET url = excluded.url, username = excluded.username, password = excluded.password,
                 etag = excluded.etag, last_sync_at = excluded.last_sync_at, last_error = NULL`,
        userId, resolved, username || null, box.seal(password || ""), r.etag, now(), now());
      return counts;
    });
    return { url: resolved, added: c.added, updated: c.updated, unchanged: c.unchanged, removed: c.removed };
  }

  async function syncUser(userId: number): Promise<MindwtrSyncResult> {
    if (running.has(userId)) return { skipped: true };
    const conn = connection(userId);
    if (!conn) return { skipped: true };
    running.add(userId);
    try {
      const r = await fetchMindwtr(conn.url, { username: conn.username, password: box.open(conn.password), etag: conn.etag });
      let c = { added: 0, updated: 0, unchanged: 0, removed: 0 };
      if (!r.unchanged) c = tx(db, () => storeMindwtr(db, userId, r.parsed, { snapshot: true }));
      run(db, "UPDATE mindwtr_connections SET etag = ?, last_sync_at = ?, last_error = NULL WHERE user_id = ?", r.etag ?? null, now(), userId);
      if (!r.unchanged) log.info(`mindwtr sync user=${userId}: ${c.added} added, ${c.updated} updated, ${c.removed} removed`);
      return { unchanged: Boolean(r.unchanged), added: c.added, updated: c.updated, removed: c.removed };
    } catch (e) {
      const msg = e instanceof MindwtrError ? e.message : `Sync failed: ${(e as Error).message}`;
      run(db, "UPDATE mindwtr_connections SET last_error = ? WHERE user_id = ?", msg, userId);
      log.warn(`mindwtr sync user=${userId} failed: ${msg}`);
      return { error: msg };
    } finally {
      running.delete(userId);
    }
  }

  async function syncAll(): Promise<void> {
    for (const { user_id } of all<{ user_id: number }>(db, "SELECT user_id FROM mindwtr_connections")) await syncUser(user_id);
  }

  function start(): void {
    if (timer) return;
    const every = Math.max(5, cfg.oura.syncIntervalMinutes) * 60 * 1000;
    nextRunAt = Date.now() + 45000;
    const loop = () => {
      nextRunAt = Date.now() + every;
      syncAll().catch(e => log.error("mindwtr scheduler:", e)).finally(() => { timer = setTimeout(loop, every); timer.unref(); });
    };
    timer = setTimeout(loop, 45000);
    timer.unref();
  }
  function stop(): void { if (timer) clearTimeout(timer); timer = null; }

  function status(userId: number): MindwtrStatus {
    const c = connection(userId);
    const n = (coll: string) => one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM mindwtr_records WHERE user_id = ? AND collection = ? AND deleted = 0", userId, coll)!.n;
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
  function disconnect(userId: number): void { run(db, "DELETE FROM mindwtr_connections WHERE user_id = ?", userId); }

  return { connect, syncUser, syncAll, start, stop, status, disconnect };
}
export type Mindwtr = ReturnType<typeof createMindwtr>;
