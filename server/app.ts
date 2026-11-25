import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Me, SignedOut } from "../shared/api.ts";
import type { Config } from "./config.ts";
import { type UserRow, openDb, now, tx, one, run } from "./db.ts";
import { verifyPassword, hashPassword, randomToken, sha256, makeBox, codesMatch, passwordProblem, USERNAME_RE } from "./crypto.ts";
import { ingestUpload, listUploads, userData, UploadError } from "./ingest.ts";
import { createOura } from "./oura.ts";
import { createMindwtr, MindwtrError } from "./mindwtr.ts";
import type { Logger } from "./log.ts";

const COOKIE = "ld_session";
// The built dashboard is one self-contained HTML file (scripts and styles inlined).
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Req = IncomingMessage;
type Res = ServerResponse;
type Route = (req: Req, res: Res, url: URL) => Promise<void>;
type Json = Record<string, unknown>;

export function createApp(cfg: Config, { log = console as Logger }: { log?: Logger } = {}) {
  const db = openDb(cfg.dbPath);
  const box = makeBox(cfg.secretKey);
  const oura = createOura({ db, cfg, box, log });
  const mindwtr = createMindwtr({ db, cfg, box, log });
  const failures = new Map<string, { n: number; until: number }>(); // ip -> failures, for login and setup throttling

  /* First-run setup: while there are no users, the first visitor can create one.
     If SETUP_CODE is set, they must also enter it. */
  const usersExist = () => Boolean(one(db, "SELECT 1 FROM users LIMIT 1"));
  function announceSetup(): void {
    if (!usersExist()) log.info(`No users yet. Open ${cfg.publicUrl} to create your account${cfg.setupCode ? " (you'll need the SETUP_CODE you configured)" : ""}.`);
  }
  const throttled = (ip: string) => { const f = failures.get(ip); return Boolean(f && f.until > Date.now()); };
  function fail(ip: string): void { const n = (failures.get(ip)?.n || 0) + 1; failures.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60 * 1000 : 0 }); }
  function startSession(res: Res, userId: number): void {
    const token = randomToken();
    run(db, "DELETE FROM sessions WHERE expires_at < ?", now());
    run(db, "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", sha256(token), userId, now(), now() + cfg.sessionDays * 86400);
    setCookie(res, token, cfg.sessionDays * 86400);
  }

  /* ---------- helpers ---------- */
  function send(res: Res, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const raw = typeof body === "string" || Buffer.isBuffer(body);
    res.writeHead(status, {
      "Content-Type": raw ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(raw ? body : JSON.stringify(body));
  }
  const redirect = (res: Res, to: string) => { res.writeHead(302, { Location: to, "Cache-Control": "no-store" }); res.end(); };

  const cookies = (req: Req): Record<string, string> => Object.fromEntries((req.headers.cookie || "").split(";")
    .map(c => c.trim().split("=")).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
  const setCookie = (res: Res, value: string, maxAge: number) => res.setHeader("Set-Cookie",
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cfg.cookieSecure ? "; Secure" : ""}`);
  const header = (req: Req, name: string) => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; };
  const clientIp = (req: Req) => (cfg.trustProxy && header(req, "x-forwarded-for")?.split(",")[0].trim()) || req.socket.remoteAddress || "";

  async function readBody(req: Req, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const ch of req as AsyncIterable<Buffer>) {
      size += ch.length;
      if (size > limit) throw new HttpError(413, `File is larger than ${Math.round(limit / 1048576)} MB.`);
      chunks.push(ch);
    }
    return Buffer.concat(chunks);
  }
  async function readJson(req: Req): Promise<Json> {
    try { const v: unknown = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}"); return v && typeof v === "object" ? v as Json : {}; }
    catch { throw new HttpError(400, "Invalid JSON body."); }
  }
  const str = (v: unknown) => (v == null ? "" : String(v));

  function sessionUser(req: Req): { id: number; username: string } | null {
    const token = cookies(req)[COOKIE];
    if (!token) return null;
    const row = one<{ id: number; username: string; expires_at: number }>(db,
      "SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", sha256(token));
    if (!row || row.expires_at < now()) return null;
    return { id: row.id, username: row.username };
  }
  const requireUser = (req: Req) => { const u = sessionUser(req); if (!u) throw new HttpError(401, "Sign in to continue."); return u; };

  /* ---------- routes ---------- */
  const routes: Record<string, Route> = {
    "POST /api/login": async (req, res) => {
      const ip = clientIp(req);
      if (throttled(ip)) throw new HttpError(429, "Too many failed sign-ins. Try again in a few minutes.");
      const body = await readJson(req);
      const user = one<UserRow>(db, "SELECT id, username, password_hash FROM users WHERE username = ?", str(body.username));
      const ok = await verifyPassword(str(body.password), user?.password_hash);
      if (!ok || !user) { fail(ip); throw new HttpError(401, "Username or password is incorrect."); }
      failures.delete(ip);
      startSession(res, user.id);
      send(res, 200, { user: { username: user.username } });
    },

    "POST /api/setup": async (req, res) => {
      const ip = clientIp(req);
      if (usersExist()) throw new HttpError(409, "Setup is already done. Sign in instead.");
      if (throttled(ip)) throw new HttpError(429, "Too many wrong setup codes. Try again in a few minutes.");
      const body = await readJson(req);
      const username = str(body.username), password = body.password;
      if (cfg.setupCode && !codesMatch(body.code, cfg.setupCode)) { fail(ip); throw new HttpError(403, "That setup code isn't right. It's the SETUP_CODE in the server's settings."); }
      if (!USERNAME_RE.test(username)) throw new HttpError(400, "Use a username of up to 64 letters, numbers, dots, dashes, underscores or @.");
      const problem = passwordProblem(password);
      if (problem) throw new HttpError(400, problem);
      const hash = await hashPassword(password as string);
      const userId = tx(db, () => {
        if (usersExist()) return null; // someone else finished setup first
        return Number(run(db, "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)", username, hash, now()).lastInsertRowid);
      });
      if (!userId) throw new HttpError(409, "Setup is already done. Sign in instead.");
      failures.delete(ip);
      log.info(`First user ${username} created through setup.`);
      startSession(res, userId);
      send(res, 201, { user: { username } });
    },

    "POST /api/logout": async (req, res) => {
      const token = cookies(req)[COOKIE];
      if (token) run(db, "DELETE FROM sessions WHERE token_hash = ?", sha256(token));
      setCookie(res, "", 0);
      send(res, 200, { ok: true });
    },

    "GET /api/me": async (req, res) => {
      const u = sessionUser(req);
      if (!u) {
        const setupRequired = !usersExist();
        const body: SignedOut = { error: "Sign in to continue.", setupRequired, setupCodeRequired: setupRequired && Boolean(cfg.setupCode) };
        return send(res, 401, body);
      }
      const me: Me = { user: { username: u.username }, oura: oura.status(u.id), mindwtr: mindwtr.status(u.id) };
      send(res, 200, me);
    },

    "GET /api/data": async (req, res) => send(res, 200, userData(db, requireUser(req).id)),

    "GET /api/uploads": async (req, res) => send(res, 200, listUploads(db, requireUser(req).id)),

    // Body is the raw file. Filename in X-Filename (URI-encoded), the file's modified time (ms) in X-Last-Modified.
    "POST /api/uploads": async (req, res) => {
      const u = requireUser(req);
      const filename = decodeURIComponent(header(req, "x-filename") || "upload").slice(0, 200);
      const body = await readBody(req, cfg.maxUploadBytes);
      if (!body.length) throw new HttpError(400, `${filename} is empty.`);
      const tz = Number(header(req, "x-tz-offset"));
      try {
        const r = ingestUpload(db, u.id, { filename, body, lastModified: Number(header(req, "x-last-modified")) || undefined, tzOffsetSec: Number.isFinite(tz) ? tz : 0 });
        send(res, r.duplicate ? 200 : 201, r);
      } catch (e) {
        if (e instanceof UploadError) throw new HttpError(422, e.message);
        throw e;
      }
    },

    "GET /api/oura/connect": async (req, res) => {
      const u = sessionUser(req);
      if (!u) return redirect(res, "/");
      if (!cfg.oura.configured) return redirect(res, "/?oura=not_configured");
      redirect(res, oura.authorizeUrl(u.id));
    },

    "GET /api/oura/callback": async (req, res, url) => {
      const userId = oura.consumeState(url.searchParams.get("state"));
      const current = sessionUser(req);
      if (!userId || (current && current.id !== userId)) return redirect(res, "/?oura=error&reason=state");
      if (url.searchParams.get("error")) return redirect(res, "/?oura=denied");
      const code = url.searchParams.get("code");
      if (!code) return redirect(res, "/?oura=error&reason=code");
      try { await oura.completeAuthorization(userId, code); }
      catch (e) { log.warn("oura authorization failed:", (e as Error).message); return redirect(res, "/?oura=error&reason=token"); }
      oura.syncUser(userId).catch(() => {}); // first backfill runs in the background
      redirect(res, "/?oura=connected");
    },

    "POST /api/oura/sync": async (req, res) => {
      const u = requireUser(req);
      const st = oura.status(u.id);
      if (!st.connected) throw new HttpError(409, "Connect Oura first.");
      if (st.status !== "active") throw new HttpError(409, "Oura needs to be connected again before it can sync.");
      const r = await oura.syncUser(u.id);
      send(res, r.error ? 502 : 200, { ...r, oura: oura.status(u.id) });
    },

    "POST /api/oura/disconnect": async (req, res) => {
      const u = requireUser(req);
      oura.disconnect(u.id);
      send(res, 200, { oura: oura.status(u.id) });
    },

    // Body: { url, username, password }. Fetches data.json once; the connection is saved only if that works.
    "POST /api/mindwtr/connect": async (req, res) => {
      const u = requireUser(req);
      const body = await readJson(req);
      try {
        const r = await mindwtr.connect(u.id, { url: str(body.url), username: str(body.username).trim(), password: str(body.password) });
        send(res, 200, { ...r, mindwtr: mindwtr.status(u.id) });
      } catch (e) {
        if (e instanceof MindwtrError) throw new HttpError(422, e.message);
        throw e;
      }
    },

    "POST /api/mindwtr/sync": async (req, res) => {
      const u = requireUser(req);
      if (!mindwtr.status(u.id).connected) throw new HttpError(409, "Connect to Mindwtr's WebDAV folder first.");
      const r = await mindwtr.syncUser(u.id);
      send(res, r.error ? 502 : 200, { ...r, mindwtr: mindwtr.status(u.id) });
    },

    "POST /api/mindwtr/disconnect": async (req, res) => {
      const u = requireUser(req);
      mindwtr.disconnect(u.id);
      send(res, 200, { mindwtr: mindwtr.status(u.id) });
    },

    "GET /healthz": async (_req, res) => { one(db, "SELECT 1"); send(res, 200, "ok"); },
  };

  async function serveDashboard(res: Res): Promise<void> {
    let html: Buffer;
    try { html = await readFile(join(cfg.clientDir, "index.html")); }
    catch { return send(res, 503, "The dashboard hasn't been built. Run: npm run build"); }
    send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP, "Cache-Control": "no-cache" });
  }

  async function handle(req: Req, res: Res): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    const url = new URL(req.url || "/", "http://local");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return await serveDashboard(res);
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, "Not found.");
      // CSRF guard: state-changing API calls must carry a custom header, which cross-site forms can't send.
      if (req.method !== "GET" && header(req, "x-life-dash") !== "1") throw new HttpError(403, "Missing X-Life-Dash header.");
      await route(req, res, url);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.error(e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong on the server." : (e as Error).message });
    }
  }

  const server = createServer((req, res) => { void handle(req, res); });
  return {
    server, db, oura, mindwtr,
    listen(port = cfg.port, host = cfg.host): Promise<AddressInfo> {
      return new Promise(r => server.listen(port, host, () => { oura.start(); mindwtr.start(); announceSetup(); r(server.address() as AddressInfo); }));
    },
    async close(): Promise<void> { oura.stop(); mindwtr.stop(); await new Promise(r => server.close(r)); db.close(); },
  };
}
export type App = ReturnType<typeof createApp>;
