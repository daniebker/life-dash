import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../server/config.ts";
import { createApp, type App } from "../server/app.ts";
import { type Resp, toResp, fixtureClientDir } from "./helpers.ts";

const dirs: string[] = [], apps: App[] = [];
after(async () => { for (const a of apps) await a.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function start(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "life-dash-setup-")); dirs.push(dir);
  const logs: string[] = [];
  const app = createApp(loadConfig({ DB_PATH: join(dir, "t.db"), SECRET_KEY: "test-secret-key-0123456789", PUBLIC_URL: "http://dash.test", CLIENT_DIR: fixtureClientDir(), ...env }),
    { log: { info: (m: unknown) => { logs.push(String(m)); }, warn() {}, error: console.error } });
  apps.push(app);
  const { port } = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";
  async function call(method: string, path: string, body?: object): Promise<Resp> {
    const headers: Record<string, string> = { "X-Life-Dash": "1" };
    if (cookie) headers.Cookie = cookie;
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    return toResp(res);
  }
  return { app, logs, call, clearCookie: () => { cookie = ""; } };
}
test("first visit offers setup without a code; the account is created and signed in", async () => {
  const { logs, call, clearCookie } = await start();
  assert.match(logs.join("\n"), /No users yet\. Open http:\/\/dash\.test to create your account\.$/m);

  const me = await call("GET", "/api/me");
  assert.equal(me.status, 401);
  assert.deepEqual([me.json.setupRequired, me.json.setupCodeRequired], [true, false]);

  assert.equal((await call("POST", "/api/setup", { username: "dan smith", password: "correct horse battery" })).status, 400);
  const short = await call("POST", "/api/setup", { username: "dan", password: "short" });
  assert.equal(short.status, 400);
  assert.match(short.json.error, /at least 10 characters/);

  const ok = await call("POST", "/api/setup", { username: "dan", password: "correct horse battery" });
  assert.equal(ok.status, 201);
  assert.equal((await call("GET", "/api/me")).json.user.username, "dan", "setup signs you in");

  assert.equal((await call("POST", "/api/setup", { username: "eve", password: "another long password" })).status, 409);

  clearCookie();
  const anon = await call("GET", "/api/me");
  assert.deepEqual([anon.json.setupRequired, anon.json.setupCodeRequired], [false, false]);
  assert.equal((await call("POST", "/api/login", { username: "dan", password: "correct horse battery" })).status, 200);
});

test("an optional SETUP_CODE is required when set, and never logged", async () => {
  const { logs, call } = await start({ SETUP_CODE: "my-own-setup-code" });
  assert.ok(!logs.join("\n").includes("my-own-setup-code"));
  assert.equal((await call("GET", "/api/me")).json.setupCodeRequired, true);
  assert.equal((await call("POST", "/api/setup", { username: "dan", password: "correct horse battery" })).status, 403);
  assert.equal((await call("POST", "/api/setup", { username: "dan", password: "correct horse battery", code: "MY-OWN-SETUP-CODE" })).status, 201);
});

test("repeated wrong setup codes are throttled", async () => {
  const { call } = await start({ SETUP_CODE: "right-code-1234" });
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/setup", { username: "dan", password: "correct horse battery", code: "wrong" })).status, 403);
  assert.equal((await call("POST", "/api/setup", { username: "dan", password: "correct horse battery", code: "right-code-1234" })).status, 429);
});

test("no setup once a user exists", async () => {
  const { app, call } = await start();
  app.db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('x', 'scrypt$1$1$1$AA==$AA==', 0)").run();
  assert.equal((await call("GET", "/api/me")).json.setupRequired, false);
  assert.equal((await call("POST", "/api/setup", { username: "dan", password: "correct horse battery" })).status, 409);
});
