import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../server/config.ts";
import { createApp } from "../server/app.ts";
import { openDb, now } from "../server/db.ts";
import { hashPassword } from "../server/crypto.ts";
import type { App } from "../server/app.ts";
import { one } from "../server/db.ts";
import { type Resp, toResp, fixtureClientDir, quiet, listen } from "./helpers.ts";

/* ---------- mock Oura (OAuth + API v2) ---------- */
const mock = { access: null as string | null, refresh: null as string | null, codes: new Map<string, string | null>(), refreshCalls: 0, failRefresh: false, apiCalls: [] as string[] };
const days = ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"];
const ouraRows: Record<string, object[]> = {
  daily_sleep: days.map((d, i) => ({ id: "ds-" + d, day: d, score: 70 + i, contributors: { deep_sleep: 80 } })),
  daily_readiness: days.map((d, i) => ({ id: "dr-" + d, day: d, score: 80 + i, temperature_deviation: 0.1, contributors: { hrv_balance: 70 } })),
  daily_activity: days.map((d, i) => ({ id: "da-" + d, day: d, score: 60 + i, steps: 8000 + i * 1000, active_calories: 300 })),
  sleep: days.map((d, i) => ({ id: "s-" + d, day: d, type: "long_sleep", bedtime_start: `${d}T00:10:00+01:00`, bedtime_end: `${d}T07:00:00+01:00`, total_sleep_duration: 25000 + i, time_in_bed: 28000, efficiency: 88, average_hrv: 40, lowest_heart_rate: 50 })),
};
let mockServer: Server, mockUrl: string;

async function startMock(): Promise<void> {
  mockServer = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", mockUrl);
    const json = (s: number, b: object) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
    if (u.pathname === "/oauth/authorize") {
      const code = "code-" + Math.random().toString(36).slice(2);
      mock.codes.set(code, u.searchParams.get("redirect_uri"));
      const back = new URL(u.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code); back.searchParams.set("state", u.searchParams.get("state") ?? "");
      res.writeHead(302, { Location: back.toString() }); return res.end();
    }
    if (u.pathname === "/oauth/token") {
      let body = ""; for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      if (p.get("client_id") !== "cid" || p.get("client_secret") !== "csecret") return json(401, { error: "invalid_client" });
      if (p.get("grant_type") === "authorization_code") {
        const code = p.get("code") ?? "";
        if (!mock.codes.has(code) || mock.codes.get(code) !== p.get("redirect_uri")) return json(400, { error: "invalid_grant" });
        mock.codes.delete(code);
      } else if (p.get("grant_type") === "refresh_token") {
        mock.refreshCalls++;
        if (mock.failRefresh || p.get("refresh_token") !== mock.refresh) return json(400, { error: "invalid_grant" });
      } else return json(400, { error: "unsupported_grant_type" });
      mock.access = "at-" + Math.random().toString(36).slice(2);
      mock.refresh = "rt-" + Math.random().toString(36).slice(2);
      return json(200, { access_token: mock.access, refresh_token: mock.refresh, expires_in: 3600, token_type: "bearer" });
    }
    const m = /^\/v2\/usercollection\/(\w+)$/.exec(u.pathname);
    if (m) {
      mock.apiCalls.push(u.pathname + u.search);
      if (req.headers.authorization !== `Bearer ${mock.access}`) return json(401, { detail: "unauthorized" });
      const all = ouraRows[m[1]] || [];
      const page = u.searchParams.get("next_token") ? 1 : 0;
      return json(200, { data: page ? all.slice(2) : all.slice(0, 2), next_token: page ? null : "p2" });
    }
    json(404, {});
  });
  mockUrl = await listen(mockServer);
}

/* ---------- app under test ---------- */
let app: App, base: string, dir: string;
const jar = { cookie: "" };

interface CallOpts { body?: unknown; headers?: Record<string, string>; raw?: boolean; noCsrf?: boolean; cookie?: string; redirect?: "manual" | "follow" | "error" }
async function call(method: string, path: string, { body, headers = {}, raw = false, noCsrf = false, cookie = jar.cookie, redirect = "manual" }: CallOpts = {}): Promise<Resp> {
  const h: Record<string, string> = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (method !== "GET" && !noCsrf) h["X-Life-Dash"] = "1";
  if (body !== undefined && !raw) { h["Content-Type"] = "application/json"; body = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers: h, body: body as string | Buffer | undefined, redirect });
  const sc = res.headers.get("set-cookie");
  if (sc && cookie === jar.cookie) jar.cookie = sc.split(";")[0].endsWith("=") ? "" : sc.split(";")[0];
  return toResp(res);
}
const upload = (filename: string, content: string | Buffer, extra: Record<string, string> = {}) => call("POST", "/api/uploads", { body: content, raw: true, headers: { "X-Filename": encodeURIComponent(filename), ...extra } });

before(async () => {
  await startMock();
  dir = mkdtempSync(join(tmpdir(), "life-dash-test-"));
  const cfg = loadConfig({
    DB_PATH: join(dir, "test.db"), SECRET_KEY: "test-secret-key-0123456789", PUBLIC_URL: "http://127.0.0.1:0", CLIENT_DIR: fixtureClientDir(),
    OURA_CLIENT_ID: "cid", OURA_CLIENT_SECRET: "csecret",
    OURA_AUTHORIZE_URL: `${mockUrl}/oauth/authorize`, OURA_TOKEN_URL: `${mockUrl}/oauth/token`, OURA_API_BASE: `${mockUrl}/v2/usercollection`,
  });
  const db = openDb(cfg.dbPath);
  db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run("dan", await hashPassword("correct horse battery"), now());
  db.close();
  app = createApp(cfg, { log: quiet });
  const addr = await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${addr.port}`;
  cfg.oura.redirectUri = `${base}/api/oura/callback`; // port is only known after listen
});
after(async () => { await app?.close(); mockServer?.close(); rmSync(dir, { recursive: true, force: true }); });

/* ---------- tests ---------- */
test("serves the dashboard", async () => {
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Life Dash<\/title>/);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal((await fetch(base + "/server/app.ts")).status, 404);
  assert.equal((await fetch(base + "/shared/parsers.ts")).status, 404);
});

test("API requires a session", async () => {
  assert.equal((await call("GET", "/api/data", { cookie: "" })).status, 401);
  assert.equal((await call("GET", "/api/me", { cookie: "ld_session=bogus" })).status, 401);
});

test("login rejects a wrong password and accepts the right one", async () => {
  const bad = await call("POST", "/api/login", { body: { username: "dan", password: "nope" }, cookie: "" });
  assert.equal(bad.status, 401);
  const unknown = await call("POST", "/api/login", { body: { username: "ghost", password: "nope" }, cookie: "" });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.error, bad.json.error, "same message for unknown user and wrong password");
  const ok = await call("POST", "/api/login", { body: { username: "DAN", password: "correct horse battery" } });
  assert.equal(ok.status, 200);
  assert.match(jar.cookie, /^ld_session=/);
  assert.match(ok.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Lax/);
  assert.equal((await call("GET", "/api/me")).json.user.username, "dan");
});

test("state-changing calls need the CSRF header", async () => {
  const r = await upload("x.csv", "a,b\n", {});
  assert.notEqual(r.status, 403);
  const blocked = await call("POST", "/api/oura/disconnect", { noCsrf: true });
  assert.equal(blocked.status, 403);
});

const LOG = `start_ts,end_ts,duration_s,start,end,activity
1,2,1,2026-11-18 11:04:20,2026-11-18 13:01:29,Work
2,3,1,2026-11-18 13:01:29,2026-11-18 13:55:33,Other
3,4,1,2026-11-18 22:11:01,2026-11-19 06:43:53,Sleep
`;

test("uploading the same file twice stores it once", async () => {
  const first = await upload("log.csv", LOG);
  assert.equal(first.status, 201);
  assert.equal(first.json.duplicate, false);
  assert.deepEqual([first.json.upload.kind, first.json.upload.added, first.json.upload.unchanged], ["log", 3, 0]);
  const again = await upload("renamed.csv", LOG);
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.upload.id, first.json.upload.id);
  assert.equal((await call("GET", "/api/data")).json.log.length, 3);
});

test("an overlapping export adds only new records and updates changed ones", async () => {
  // same first two rows, a longer sleep (later end), and one new row
  const next = LOG.replace("2026-11-19 06:43:53,Sleep", "2026-11-19 07:00:00,Sleep") + "5,6,1,2026-11-19 07:00:00,2026-11-19 07:30:00,Eating\n";
  const r = await upload("log-2.csv", next);
  assert.equal(r.status, 201);
  assert.deepEqual([r.json.upload.added, r.json.upload.updated, r.json.upload.unchanged], [1, 1, 2]);
  const log = (await call("GET", "/api/data")).json.log;
  assert.equal(log.length, 4);
  assert.equal(log.find((e: { act: string }) => e.act === "Sleep").e, Date.UTC(2026, 10, 19, 7, 0, 0) / 1000);
});

test("check-ins, activities and habits are deduplicated by record", async () => {
  const chk = "2026-11-24 12:50,Sad,Lonely,Isolated\n2026-11-24 13:15,Happy,Content,Free\n";
  assert.equal((await upload("checkins.csv", chk)).json.upload.added, 2);
  const more = await upload("checkins-2.csv", chk + "2026-11-25 09:02,Happy,Playful,\n");
  assert.deepEqual([more.json.upload.added, more.json.upload.unchanged], [1, 2]);

  assert.equal((await upload("activities.txt", "Work\nSleep\nRead\n")).json.upload.added, 3);
  assert.deepEqual([(await upload("activities-2.txt", "Work\nCode\n")).json.upload.added], [1]);

  // minimal HBT1 file: one habit "Water", target 8, values on day-of-year 320 and 321
  const rs = 404, buf = Buffer.alloc(12 + rs);
  buf.write("HBT1", 0); buf.writeUInt16LE(1, 4); buf.writeUInt16LE(rs, 6); buf.writeUInt32LE(1, 8);
  buf.write("Water", 12); buf.writeUInt16LE(8, 12 + 24); buf[12 + 26 + 320] = 5; buf[12 + 26 + 321] = 8;
  const lm = String(Date.UTC(2026, 10, 25));
  const h1 = await upload("habits.dat", buf, { "X-Last-Modified": lm });
  assert.deepEqual([h1.json.upload.kind, h1.json.upload.added], ["habits", 2]);
  const buf2 = Buffer.from(buf); buf2[12 + 26 + 320] = 6; buf2[12 + 26 + 322] = 1;
  const h2 = await upload("habits.dat", buf2, { "X-Last-Modified": lm });
  assert.deepEqual([h2.json.upload.added, h2.json.upload.updated, h2.json.upload.unchanged], [1, 1, 1]);

  const data = (await call("GET", "/api/data")).json;
  assert.equal(data.checkins.length, 3);
  assert.deepEqual(data.activities.sort(), ["Code", "Read", "Sleep", "Work"]);
  assert.deepEqual(data.habits, [{ name: "Water", target: 8, days: { "2026-11-17": 6, "2026-11-18": 8, "2026-11-19": 1 } }]);
});

test("unrecognised files are rejected and not stored", async () => {
  const r = await upload("notes.csv", "a,b,c\n1,2,3\n");
  assert.equal(r.status, 422);
  assert.match(r.json.error, /Couldn't recognise notes\.csv/);
  assert.ok(!(await call("GET", "/api/uploads")).json.some((u: { filename: string }) => u.filename === "notes.csv"));
});

test("Oura: connect through OAuth, background backfill, then manual sync dedupes", async () => {
  const me0 = (await call("GET", "/api/me")).json.oura;
  assert.deepEqual([me0.configured, me0.connected], [true, false]);

  // /api/oura/connect -> mock authorize -> /api/oura/callback
  const c = await call("GET", "/api/oura/connect");
  assert.equal(c.status, 302);
  const authorize = new URL(c.headers.get("location") ?? "");
  assert.equal(authorize.searchParams.get("client_id"), "cid");
  assert.equal(authorize.searchParams.get("scope"), "personal daily");
  const a = await fetch(authorize, { redirect: "manual" });
  const callback = a.headers.get("location") ?? "";
  const cb = await call("GET", callback.replace(base, ""));
  assert.equal(cb.headers.get("location"), "/?oura=connected");

  // the callback starts the first sync in the background
  let st;
  for (let i = 0; i < 50; i++) { st = (await call("GET", "/api/me")).json.oura; if (st.lastSyncAt && !st.syncing) break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(st.connected, true);
  assert.equal(st.status, "active");
  assert.equal(st.records, 16);
  assert.ok(mock.apiCalls.some(u => u.includes("next_token=p2")), "follows pagination");

  const again = await call("POST", "/api/oura/sync");
  assert.equal(again.status, 200);
  assert.deepEqual([again.json.added, again.json.updated, again.json.unchanged], [0, 0, 16]);

  // the state can't be replayed
  const replay = await call("GET", callback.replace(base, ""));
  assert.equal(replay.headers.get("location"), "/?oura=error&reason=state");

  const data = (await call("GET", "/api/data")).json;
  assert.equal(data.oura[0].daily_activity.length, 4);
});

test("Oura: an uploaded export merges with synced records", async () => {
  const exp = { data: [{ ...ouraRows.daily_activity[0], steps: 12345 }, { id: "da-2026-11-24", day: "2026-11-24", score: 90, steps: 4000, active_calories: 100 }] };
  const r = await upload("oura.json", JSON.stringify(exp));
  assert.deepEqual([r.json.upload.kind, r.json.upload.added, r.json.upload.updated], ["oura", 1, 1]);
  const acts = (await call("GET", "/api/data")).json.oura[0].daily_activity;
  assert.equal(acts.length, 5);
  assert.equal(acts.find((x: { day: string }) => x.day === "2026-11-20").steps, 12345);
});

test("Oura: expired access is refreshed; a revoked refresh token asks to reconnect", async () => {
  mock.access = "rotated-elsewhere"; // our stored access token is now rejected with 401
  const before = mock.refreshCalls;
  const ok = await call("POST", "/api/oura/sync");
  assert.equal(ok.status, 200);
  assert.equal(mock.refreshCalls, before + 1);

  mock.access = "rotated-again"; mock.failRefresh = true;
  const bad = await call("POST", "/api/oura/sync");
  assert.equal(bad.status, 502);
  assert.equal(bad.json.reauth, true);
  assert.equal(bad.json.oura.status, "needs_reauth");
  assert.match(bad.json.oura.lastError, /Connect Oura again/);
  mock.failRefresh = false;
});

test("tokens are encrypted at rest", async () => {
  const row = one<{ access_token: string; refresh_token: string }>(app.db, "SELECT access_token, refresh_token FROM oura_connections")!;
  assert.match(row.access_token, /^v1\./);
  assert.ok(!row.refresh_token.includes(mock.refresh ?? "-"));
});

test("disconnect keeps stored data; logout ends the session", async () => {
  const d = await call("POST", "/api/oura/disconnect");
  assert.equal(d.json.oura.connected, false);
  assert.ok(d.json.oura.records > 0);
  await call("POST", "/api/logout");
  assert.equal(jar.cookie, "");
  assert.equal((await call("GET", "/api/me", { cookie: "" })).status, 401);
});

test("repeated failed logins are throttled", async () => {
  for (let i = 0; i < 5; i++) await call("POST", "/api/login", { body: { username: "dan", password: "wrong" }, cookie: "" });
  const r = await call("POST", "/api/login", { body: { username: "dan", password: "correct horse battery" }, cookie: "" });
  assert.equal(r.status, 429);
});
