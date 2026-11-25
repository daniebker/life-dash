import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./config.mjs";
import { openDb, now } from "./db.mjs";
import { verifyPassword, randomToken, sha256, makeBox } from "./crypto.mjs";
import { ingestUpload, userData, UploadError } from "./ingest.mjs";
import { createOura } from "./oura.mjs";

const COOKIE = "ld_session";
const STATIC = { "/": ["index.html", "text/html; charset=utf-8"], "/index.html": ["index.html", "text/html; charset=utf-8"], "/parsers.js": ["parsers.js", "text/javascript; charset=utf-8"] };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function createApp(cfg, { log = console } = {}) {
  const db = openDb(cfg.dbPath);
  const box = makeBox(cfg.secretKey);
  const oura = createOura({ db, cfg, box, log });
  const failures = new Map(); // ip -> { n, until } for login throttling

  /* ---------- helpers ---------- */
  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
    res.writeHead(status, {
      "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  };
  const redirect = (res, to) => { res.writeHead(302, { Location: to, "Cache-Control": "no-store" }); res.end(); };

  const cookies = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
  const setCookie = (res, value, maxAge) => res.setHeader("Set-Cookie",
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cfg.cookieSecure ? "; Secure" : ""}`);
  const clientIp = req => (cfg.trustProxy && req.headers["x-forwarded-for"]?.split(",")[0].trim()) || req.socket.remoteAddress;

  async function readBody(req, limit) {
    const chunks = []; let size = 0;
    for await (const ch of req) {
      size += ch.length;
      if (size > limit) throw new HttpError(413, `File is larger than ${Math.round(limit / 1048576)} MB.`);
      chunks.push(ch);
    }
    return Buffer.concat(chunks);
  }
  const readJson = async req => { try { return JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}"); } catch { throw new HttpError(400, "Invalid JSON body."); } };

  function sessionUser(req) {
    const token = cookies(req)[COOKIE];
    if (!token) return null;
    const row = db.prepare("SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?").get(sha256(token));
    if (!row || row.expires_at < now()) return null;
    return { id: row.id, username: row.username };
  }
  const requireUser = req => { const u = sessionUser(req); if (!u) throw new HttpError(401, "Sign in to continue."); return u; };

  /* ---------- routes ---------- */
  const routes = {
    "POST /api/login": async (req, res) => {
      const ip = clientIp(req), f = failures.get(ip);
      if (f && f.until > Date.now()) throw new HttpError(429, "Too many failed sign-ins. Try again in a few minutes.");
      const { username = "", password = "" } = await readJson(req);
      const user = db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?").get(String(username));
      const ok = await verifyPassword(String(password), user?.password_hash);
      if (!ok) {
        const n = (f?.n || 0) + 1;
        failures.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
        throw new HttpError(401, "Username or password is incorrect.");
      }
      failures.delete(ip);
      const token = randomToken();
      db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
      db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), user.id, now(), now() + cfg.sessionDays * 86400);
      setCookie(res, token, cfg.sessionDays * 86400);
      send(res, 200, { user: { username: user.username } });
    },

    "POST /api/logout": async (req, res) => {
      const token = cookies(req)[COOKIE];
      if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
      setCookie(res, "", 0);
      send(res, 200, { ok: true });
    },

    "GET /api/me": async (req, res) => {
      const u = requireUser(req);
      send(res, 200, { user: { username: u.username }, oura: oura.status(u.id) });
    },

    "GET /api/data": async (req, res) => send(res, 200, userData(db, requireUser(req).id)),

    "GET /api/uploads": async (req, res) => {
      const u = requireUser(req);
      send(res, 200, db.prepare("SELECT id, filename, kind, size, created_at, added, updated, unchanged FROM uploads WHERE user_id = ? ORDER BY id DESC").all(u.id));
    },

    // Body is the raw file. Filename in X-Filename (URI-encoded), the file's modified time (ms) in X-Last-Modified.
    "POST /api/uploads": async (req, res) => {
      const u = requireUser(req);
      const filename = decodeURIComponent(req.headers["x-filename"] || "upload").slice(0, 200);
      const body = await readBody(req, cfg.maxUploadBytes);
      if (!body.length) throw new HttpError(400, `${filename} is empty.`);
      const tz = Number(req.headers["x-tz-offset"]);
      try {
        const r = ingestUpload(db, u.id, { filename, body, lastModified: Number(req.headers["x-last-modified"]) || undefined, tzOffsetSec: Number.isFinite(tz) ? tz : 0 });
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
      catch (e) { log.warn?.("oura authorization failed:", e.message); return redirect(res, "/?oura=error&reason=token"); }
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

    "GET /healthz": async (req, res) => { db.prepare("SELECT 1").get(); send(res, 200, "ok"); },
  };

  async function handle(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    const url = new URL(req.url, "http://local");
    try {
      if (req.method === "GET" && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(res, 200, await readFile(join(ROOT, file)), { "Content-Type": type, "Content-Security-Policy": CSP, "Cache-Control": "no-cache" });
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, "Not found.");
      // CSRF guard: state-changing API calls must carry a custom header, which cross-site forms can't send.
      if (req.method !== "GET" && req.headers["x-life-dash"] !== "1") throw new HttpError(403, "Missing X-Life-Dash header.");
      await route(req, res, url);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) log.error?.(e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong on the server." : e.message });
    }
  }

  const server = createServer(handle);
  return {
    server, db, oura,
    listen(port = cfg.port, host = cfg.host) {
      return new Promise(r => server.listen(port, host, () => { oura.start(); r(server.address()); }));
    },
    async close() { oura.stop(); await new Promise(r => server.close(r)); db.close(); },
  };
}
