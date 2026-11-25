#!/usr/bin/env node
import { loadConfig, assertConfig } from "./config.mjs";
import { createApp } from "./app.mjs";

const cfg = loadConfig();
try { assertConfig(cfg); } catch (e) { console.error(e.message); process.exit(1); }

const app = createApp(cfg);
const addr = await app.listen();
console.log(`Life Dash listening on http://${addr.address}:${addr.port} (public URL ${cfg.publicUrl})`);
console.log(cfg.oura.configured
  ? `Oura sync every ${cfg.oura.syncIntervalMinutes} min; OAuth redirect URI: ${cfg.oura.redirectUri}`
  : "Oura is not configured (set OURA_CLIENT_ID and OURA_CLIENT_SECRET to enable it).");
if (!app.db.prepare("SELECT 1 FROM users LIMIT 1").get()) console.log("No users yet. Create one with: node server/cli.mjs add <username> (in Docker: docker compose exec life-dash node server/cli.mjs add <username>)");

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await app.close(); process.exit(0); });
