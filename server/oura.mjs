import "../parsers.js";
import { now, tx } from "./db.mjs";
import { randomToken, sha256 } from "./crypto.mjs";
import { storeOura } from "./ingest.mjs";

const P = globalThis.LifeParsers;
const STATE_TTL = 600; // seconds an OAuth "state" stays valid

export class OuraError extends Error {
  constructor(message, { reauth = false, status } = {}) { super(message); this.reauth = reauth; this.status = status; }
}

export function createOura({ db, cfg, box, log = console }) {
  const o = cfg.oura;
  const running = new Set();
  let timer = null, nextRunAt = null;

  /* ---------- OAuth ---------- */
  function authorizeUrl(userId) {
    const state = randomToken(24);
    db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(now() - STATE_TTL);
    db.prepare("INSERT INTO oauth_states (state_hash, user_id, created_at) VALUES (?, ?, ?)").run(sha256(state), userId, now());
    const u = new URL(o.authorizeUrl);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", o.clientId);
    u.searchParams.set("redirect_uri", o.redirectUri);
    u.searchParams.set("scope", o.scopes);
    u.searchParams.set("state", state);
    return u.toString();
  }

  // Returns the user id the state was issued to, and consumes it.
  function consumeState(state) {
    if (!state) return null;
    const h = sha256(state);
    const row = db.prepare("SELECT user_id, created_at FROM oauth_states WHERE state_hash = ?").get(h);
    db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").run(h);
    return row && row.created_at >= now() - STATE_TTL ? row.user_id : null;
  }

  async function tokenRequest(params) {
    const res = await fetch(o.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ...params, client_id: o.clientId, client_secret: o.clientSecret }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      const msg = body.error_description || body.error || `HTTP ${res.status}`;
      throw new OuraError(`Oura token request failed: ${msg}`, { reauth: res.status === 400 || res.status === 401, status: res.status });
    }
    return body;
  }

  function saveTokens(userId, t, prev) {
    const expires = t.expires_in ? now() + Number(t.expires_in) : null;
    const refresh = t.refresh_token ?? (prev ? box.open(prev.refresh_token) : null);
    db.prepare(`INSERT INTO oura_connections (user_id, access_token, refresh_token, expires_at, scope, status, created_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?)
                ON CONFLICT (user_id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
                  expires_at = excluded.expires_at, scope = COALESCE(excluded.scope, scope), status = 'active', last_error = NULL`)
      .run(userId, box.seal(t.access_token), box.seal(refresh), expires, t.scope ?? null, now());
  }

  async function completeAuthorization(userId, code) {
    const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: o.redirectUri });
    saveTokens(userId, t, null);
  }

  const connection = userId => db.prepare("SELECT * FROM oura_connections WHERE user_id = ?").get(userId);

  async function refresh(userId) {
    const conn = connection(userId);
    const rt = conn && box.open(conn.refresh_token);
    if (!rt) throw new OuraError("Oura access expired and there is no refresh token. Connect Oura again.", { reauth: true });
    try { saveTokens(userId, await tokenRequest({ grant_type: "refresh_token", refresh_token: rt }), conn); }
    catch (e) { if (e.reauth) e.message = "Oura access was revoked or expired. Connect Oura again."; throw e; }
    return box.open(connection(userId).access_token);
  }

  async function accessToken(userId) {
    const conn = connection(userId);
    if (!conn) throw new OuraError("Oura is not connected.");
    if (conn.expires_at && conn.expires_at - 60 <= now()) return refresh(userId);
    return box.open(conn.access_token);
  }

  /* ---------- API ---------- */
  async function fetchCollection(userId, name, start, end, tokenRef) {
    const rows = [];
    let next = null, retried = false;
    for (;;) {
      const u = new URL(`${o.apiBase}/${name}`);
      u.searchParams.set("start_date", start);
      u.searchParams.set("end_date", end);
      if (next) u.searchParams.set("next_token", next);
      const res = await fetch(u, { headers: { Authorization: `Bearer ${tokenRef.token}`, Accept: "application/json" } });
      if (res.status === 401 && !retried) { retried = true; tokenRef.token = await refresh(userId); continue; }
      if (res.status === 401 || res.status === 403) throw new OuraError(`Oura refused access to ${name} (HTTP ${res.status}). Connect Oura again and allow the requested data.`, { reauth: true, status: res.status });
      if (res.status === 429) throw new OuraError("Oura rate limit reached. The next scheduled sync will try again.", { status: 429 });
      if (!res.ok) throw new OuraError(`Oura ${name} request failed (HTTP ${res.status}).`, { status: res.status });
      const body = await res.json();
      rows.push(...(body.data || []));
      next = body.next_token || null;
      if (!next) return rows;
    }
  }

  const isoDay = t => new Date(t * 1000).toISOString().slice(0, 10);

  async function syncUser(userId) {
    if (running.has(userId)) return { skipped: true };
    const conn = connection(userId);
    if (!conn || conn.status !== "active") return { skipped: true };
    running.add(userId);
    const run = db.prepare("INSERT INTO sync_runs (user_id, started_at) VALUES (?, ?)").run(userId, now()).lastInsertRowid;
    try {
      const today = now();
      const from = conn.last_sync_day
        ? Math.min(P.naive(conn.last_sync_day + " 00:00") - o.overlapDays * 86400, today - o.overlapDays * 86400)
        : today - o.backfillDays * 86400;
      const start = isoDay(from), end = isoDay(today + 86400);
      const tokenRef = { token: await accessToken(userId) };
      const collections = {};
      for (const name of P.OURA_KEYS) collections[name] = await fetchCollection(userId, name, start, end, tokenRef);
      const c = tx(db, () => storeOura(db, userId, collections));
      db.prepare("UPDATE oura_connections SET last_sync_at = ?, last_sync_day = ?, last_error = NULL WHERE user_id = ?").run(now(), isoDay(today), userId);
      db.prepare("UPDATE sync_runs SET finished_at = ?, added = ?, updated = ? WHERE id = ?").run(now(), c.added, c.updated, run);
      log.info?.(`oura sync user=${userId} ${start}..${end}: ${c.added} added, ${c.updated} updated`);
      return { added: c.added, updated: c.updated, unchanged: c.unchanged, from: start };
    } catch (e) {
      const msg = e instanceof OuraError ? e.message : `Sync failed: ${e.message}`;
      db.prepare("UPDATE oura_connections SET last_error = ?, status = CASE WHEN ? THEN 'needs_reauth' ELSE status END WHERE user_id = ?").run(msg, e.reauth ? 1 : 0, userId);
      db.prepare("UPDATE sync_runs SET finished_at = ?, error = ? WHERE id = ?").run(now(), msg, run);
      log.warn?.(`oura sync user=${userId} failed: ${msg}`);
      return { error: msg, reauth: Boolean(e.reauth) };
    } finally {
      running.delete(userId);
    }
  }

  async function syncAll() {
    const users = db.prepare("SELECT user_id FROM oura_connections WHERE status = 'active'").all();
    for (const { user_id } of users) await syncUser(user_id);
  }

  /* ---------- background schedule ---------- */
  function start() {
    if (!o.configured || timer) return;
    const every = Math.max(5, o.syncIntervalMinutes) * 60 * 1000;
    const tick = async () => {
      nextRunAt = Date.now() + every;
      try { await syncAll(); } catch (e) { log.error?.("oura scheduler:", e); }
    };
    nextRunAt = Date.now() + 30000;
    timer = setTimeout(function loop() { tick().finally(() => { timer = setTimeout(loop, every); timer.unref?.(); }); }, 30000);
    timer.unref?.();
  }
  function stop() { clearTimeout(timer); timer = null; }

  function status(userId) {
    const c = connection(userId);
    return {
      configured: o.configured,
      connected: Boolean(c),
      status: c?.status ?? null,
      syncing: running.has(userId),
      lastSyncAt: c?.last_sync_at ?? null,
      lastError: c?.last_error ?? null,
      nextSyncAt: c && c.status === "active" && nextRunAt ? Math.floor(nextRunAt / 1000) : null,
      records: db.prepare("SELECT COUNT(*) AS n FROM oura_records WHERE user_id = ?").get(userId).n,
    };
  }

  function disconnect(userId) {
    db.prepare("DELETE FROM oura_connections WHERE user_id = ?").run(userId);
  }

  return { authorizeUrl, consumeState, completeAuthorization, syncUser, syncAll, start, stop, status, disconnect };
}
