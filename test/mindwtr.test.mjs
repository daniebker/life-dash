import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../server/config.mjs";
import { createApp } from "../server/app.mjs";
import { openDb, now } from "../server/db.mjs";
import { hashPassword } from "../server/crypto.mjs";
import { resolveMindwtrUrl } from "../server/mindwtr.mjs";

/* ---------- a Mindwtr-like data.json ---------- */
const iso = (d, h = 9) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
function doc() {
  return {
    tasks: [
      { id: "t1", title: "Write report", status: "done", tags: [], contexts: ["@work"], projectId: "p1", createdAt: iso(20), updatedAt: iso(24), completedAt: iso(24) },
      { id: "t2", title: "Call plumber", status: "next", tags: [], contexts: ["@phone"], createdAt: iso(21), updatedAt: iso(21), dueDate: "2026-11-23" },
      { id: "t3", title: "Old idea", status: "someday", tags: [], contexts: [], createdAt: iso(1), updatedAt: iso(22), deletedAt: iso(22) },
    ],
    projects: [{ id: "p1", title: "Q4 report", status: "active", color: "#3b82f6", order: 0, tagIds: [], areaId: "a1", createdAt: iso(1), updatedAt: iso(20) }],
    sections: [],
    areas: [{ id: "a1", name: "Work", order: 0, createdAt: iso(1), updatedAt: iso(1) }],
    settings: { deviceId: "dev-1", ai: { apiKey: "sk-should-never-be-stored" } },
  };
}

/* ---------- mock WebDAV server ---------- */
const dav = { doc: doc(), version: 1, gets: 0, notModified: 0 };
let davServer, davUrl;
function startDav() {
  davServer = createServer((req, res) => {
    const auth = req.headers.authorization || "";
    if (auth !== "Basic " + Buffer.from("dan:app-password").toString("base64")) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="dav"' }); return res.end(); }
    if (req.url === "/remote.php/dav/files/dan/Mindwtr/data.json") {
      dav.gets++;
      const etag = `"v${dav.version}"`;
      if (req.headers["if-none-match"] === etag) { dav.notModified++; res.writeHead(304, { ETag: etag }); return res.end(); }
      res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
      return res.end("﻿" + JSON.stringify(dav.doc, null, 2));
    }
    if (req.url === "/remote.php/dav/files/dan/Encrypted/data.json") { res.writeHead(200); return res.end(Buffer.from([0x4d, 0x57, 0x00, 0xff, 0x13])); }
    res.writeHead(404); res.end();
  });
  return new Promise(r => davServer.listen(0, "127.0.0.1", () => { davUrl = `http://127.0.0.1:${davServer.address().port}`; r(); }));
}

/* ---------- app ---------- */
let app, base, dir, cookie = "";
async function call(method, path, body, headers = {}) {
  const h = { "X-Life-Dash": "1", Cookie: cookie, ...headers };
  let payload = body;
  if (body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body)) { h["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}
const upload = (name, content) => call("POST", "/api/uploads", content, { "X-Filename": name });

before(async () => {
  await startDav();
  dir = mkdtempSync(join(tmpdir(), "life-dash-mw-"));
  const cfg = loadConfig({ DB_PATH: join(dir, "t.db"), SECRET_KEY: "test-secret-key-0123456789", PUBLIC_URL: "http://dash.test" });
  const db = openDb(cfg.dbPath);
  db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run("dan", await hashPassword("correct horse battery"), now());
  db.close();
  app = createApp(cfg, { log: { info() {}, warn() {}, error: console.error } });
  base = `http://127.0.0.1:${(await app.listen(0, "127.0.0.1")).port}`;
  await call("POST", "/api/login", { username: "dan", password: "correct horse battery" });
});
after(async () => { await app?.close(); davServer?.close(); rmSync(dir, { recursive: true, force: true }); });

test("WebDAV addresses: a folder gets data.json appended; web-page and credential URLs are refused", () => {
  assert.equal(resolveMindwtrUrl("https://cloud.example.com/remote.php/dav/files/dan/Mindwtr"), "https://cloud.example.com/remote.php/dav/files/dan/Mindwtr/data.json");
  assert.equal(resolveMindwtrUrl("https://cloud.example.com/remote.php/dav/files/dan/Mindwtr/"), "https://cloud.example.com/remote.php/dav/files/dan/Mindwtr/data.json");
  assert.equal(resolveMindwtrUrl("https://dav.example.com/backup/mindwtr.json"), "https://dav.example.com/backup/mindwtr.json");
  assert.throws(() => resolveMindwtrUrl("https://cloud.example.com/index.php/apps/files/?dir=/Mindwtr"), /Nextcloud web page/);
  assert.throws(() => resolveMindwtrUrl("https://dan:pw@cloud.example.com/dav/"), /own fields/);
  assert.throws(() => resolveMindwtrUrl("ftp://example.com/x"), /https:\/\//);
});

test("an uploaded data.json is stored without its settings and de-duplicated", async () => {
  const text = JSON.stringify(doc());
  const r = await upload("data.json", text);
  assert.equal(r.status, 201);
  assert.deepEqual([r.json.upload.kind, r.json.upload.added], ["mindwtr", 5]); // 3 tasks, 1 project, 1 area
  const stored = app.db.prepare("SELECT content FROM uploads WHERE id = ?").get(r.json.upload.id).content;
  assert.ok(!Buffer.from(stored).toString().includes("sk-should-never-be-stored"), "settings are dropped");
  assert.equal((await upload("copy.json", text)).json.duplicate, true);

  // an older export never overwrites newer data; a newer one updates
  const older = doc(); older.tasks[1].title = "Old title"; older.tasks[1].updatedAt = iso(10);
  assert.deepEqual([(await upload("old.json", JSON.stringify(older))).json.upload.updated], [0]);
  const newer = doc(); newer.tasks[1].title = "Call the plumber"; newer.tasks[1].updatedAt = iso(25);
  assert.equal((await upload("new.json", JSON.stringify(newer))).json.upload.updated, 1);

  const data = (await call("GET", "/api/data")).json.mindwtr[0];
  assert.deepEqual(data.tasks.map(t => t.title).sort(), ["Call the plumber", "Write report"], "deleted task is hidden");
  assert.deepEqual(data.areas, [{ id: "a1", name: "Work" }]);
});

test("connecting with a wrong password saves nothing", async () => {
  const r = await call("POST", "/api/mindwtr/connect", { url: `${davUrl}/remote.php/dav/files/dan/Mindwtr/`, username: "dan", password: "nope" });
  assert.equal(r.status, 422);
  assert.match(r.json.error, /refused the username or password/);
  assert.equal((await call("GET", "/api/me")).json.mindwtr.connected, false);
});

test("missing file and encrypted file give clear errors", async () => {
  const missing = await call("POST", "/api/mindwtr/connect", { url: `${davUrl}/remote.php/dav/files/dan/Nope`, username: "dan", password: "app-password" });
  assert.match(missing.json.error, /no data\.json at that address/);
  const enc = await call("POST", "/api/mindwtr/connect", { url: `${davUrl}/remote.php/dav/files/dan/Encrypted`, username: "dan", password: "app-password" });
  assert.match(enc.json.error, /sync encryption/);
});

test("connect, then background syncs skip unchanged files and follow remote edits and removals", async () => {
  const c = await call("POST", "/api/mindwtr/connect", { url: `${davUrl}/remote.php/dav/files/dan/Mindwtr`, username: "dan", password: "app-password" });
  assert.equal(c.status, 200);
  assert.equal(c.json.url, `${davUrl}/remote.php/dav/files/dan/Mindwtr/data.json`);
  assert.equal(c.json.mindwtr.connected, true);
  assert.equal(c.json.mindwtr.tasks, 2);

  const same = await call("POST", "/api/mindwtr/sync");
  assert.equal(same.json.unchanged, true);
  assert.equal(dav.notModified, 1, "sent If-None-Match and got 304");

  // remote changes: rename t2, drop t1 from the file entirely, add t4
  dav.doc.tasks[1].title = "Plumber booked"; dav.doc.tasks[1].updatedAt = iso(25);
  dav.doc.tasks.splice(0, 1);
  dav.doc.tasks.push({ id: "t4", title: "Plan holiday", status: "inbox", tags: [], contexts: [], createdAt: iso(25), updatedAt: iso(25) });
  dav.version++;
  const s = await call("POST", "/api/mindwtr/sync");
  assert.deepEqual([s.json.added, s.json.updated, s.json.removed], [1, 1, 1]);
  const titles = (await call("GET", "/api/data")).json.mindwtr[0].tasks.map(t => t.title).sort();
  assert.deepEqual(titles, ["Plan holiday", "Plumber booked"]);

  // the scheduler path does the same
  dav.doc.tasks[0].status = "done"; dav.doc.tasks[0].completedAt = iso(25, 12); dav.doc.tasks[0].updatedAt = iso(25, 12); dav.version++;
  await app.mindwtr.syncAll();
  assert.equal((await call("GET", "/api/data")).json.mindwtr[0].tasks.find(t => t.id === "t2").status, "done");
});

test("the WebDAV password is encrypted at rest; disconnect keeps the tasks", async () => {
  const row = app.db.prepare("SELECT password FROM mindwtr_connections").get();
  assert.match(row.password, /^v1\./);
  assert.ok(!row.password.includes("app-password"));
  const d = await call("POST", "/api/mindwtr/disconnect");
  assert.equal(d.json.mindwtr.connected, false);
  assert.ok(d.json.mindwtr.tasks > 0);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM mindwtr_connections").get().n, 0);
});

test("sync failures are reported on the connection", async () => {
  await call("POST", "/api/mindwtr/connect", { url: `${davUrl}/remote.php/dav/files/dan/Mindwtr`, username: "dan", password: "app-password" });
  app.db.prepare("UPDATE mindwtr_connections SET url = ?").run(`${davUrl}/remote.php/dav/files/dan/Gone/data.json`);
  const r = await call("POST", "/api/mindwtr/sync");
  assert.equal(r.status, 502);
  assert.match(r.json.mindwtr.lastError, /no data\.json/);
});
