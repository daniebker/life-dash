#!/usr/bin/env node
import { loadConfig, assertConfig } from "./config.ts";
import { createApp } from "./app.ts";

const cfg = loadConfig();
try { assertConfig(cfg); } catch (e) { console.error((e as Error).message); process.exit(1); }

const app = createApp(cfg);
const addr = await app.listen();
console.log(`Life Dash listening on http://${addr.address}:${addr.port} (public URL ${cfg.publicUrl})`);
console.log(cfg.oura.configured
  ? `Oura sync every ${cfg.oura.syncIntervalMinutes} min; OAuth redirect URI: ${cfg.oura.redirectUri}`
  : "Oura is not configured (set OURA_CLIENT_ID and OURA_CLIENT_SECRET to enable it).");

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
