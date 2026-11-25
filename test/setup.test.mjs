import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../server/config.mjs";
import { createApp } from "../server/app.mjs";

const dirs = [], apps = [];
after(async () => { for (const a of apps) await a.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function start(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "life-dash-setup-")); dirs.push(dir);
  const logs = [];
  const app = createApp(loadConfig({ DB_PATH: join(dir, "t.db"), SECRET_KEY: "test-secret-key-0123456789", PUBLIC_URL: "http://dash.test", ...env }),
    { log: { info: m => logs.push(m), warn() {}, error: console.error } });
  apps.push(app);
  const { port } = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";
  async function call(method, path, body) {
    const headers = { "X-Life-Dash": "1" };
    if (cookie) headers.Cookie = cookie;
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  return { app, logs, call, clearCookie: () => { cookie = ""; } };
}
const codeFrom = logs => /setup code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(logs.join("\n"))?.[1];

test("first visit asks for setup; the account is created with the logged code", async () => {
  const { logs, call, clearCookie } = await start();
  const code = codeFrom(logs);
  assert.ok(code, "setup code is printed at startup");

  const me = await call("GET", "/api/me");
  assert.equal(me.status, 401);
  assert.equal(me.json.setupRequired, true);

  assert.equal((await call("POST", "/api/setup", { username: "dan", password: "correct horse battery", code: "WRONG-CODE" })).status, 403);
  assert.equal((await call("POST", "/api/setup", { username: "dan smith", password: "correct horse battery", code })).status, 400);
  const short = await call("POST", "/api/setup", { username: "dan", password: "short", code });
  assert.equal(short.status, 400);
  assert.match(short.json.error, /at least 10 characters/);

  // code is accepted in any case and without the dash
  const ok = await call("POST", "/api/setup", { username: "dan", password: "correct horse battery", code: code.toLowerCase().replace("-", "") });
  assert.equal(ok.status, 201);
  assert.equal((await call("GET", "/api/me")).json.user.username, "dan", "setup signs you in");

  const again = await call("POST", "/api/setup", { username: "eve", password: "another long password", code });
  assert.equal(again.status, 409);

  clearCookie();
  const anon = await call("GET", "/api/me");
  assert.equal(anon.json.setupRequired, false);
  assert.equal((await call("POST", "/api/login", { username: "dan", password: "correct horse battery" })).status, 200);
});

test("SETUP_CODE replaces the generated code and isn't logged", async () => {
  const { logs, call } = await start({ SETUP_CODE: "my-own-setup-code" });
  assert.equal(codeFrom(logs), undefined);
  assert.ok(!logs.join("\n").includes("my-own-setup-code"));
  assert.match(logs.join("\n"), /SETUP_CODE you configured/);
  assert.equal((await call("POST", "/api/setup", { username: "dan", password: "correct horse battery", code: "MY-OWN-SETUP-CODE" })).status, 201);
});

test("repeated wrong setup codes are throttled", async () => {
  const { logs, call } = await start();
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/setup", { username: "dan", password: "correct horse battery", code: "AAAA-AAAA" })).status, 403);
  const r = await call("POST", "/api/setup", { username: "dan", password: "correct horse battery", code: codeFrom(logs) });
  assert.equal(r.status, 429);
});

test("no setup prompt once a user exists", async () => {
  const { app, logs, call } = await start();
  logs.length = 0;
  app.db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('x', 'scrypt$1$1$1$AA==$AA==', 0)").run();
  const me = await call("GET", "/api/me");
  assert.equal(me.json.setupRequired, false);
  assert.equal((await call("POST", "/api/setup", { username: "dan", password: "correct horse battery", code: "anything" })).status, 409);
});
