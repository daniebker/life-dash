#!/usr/bin/env node
// Fetch Oura Ring data (API v2) into data/oura.json for Life Dash.
//
// Usage:
//   OURA_TOKEN=... node scripts/oura-sync.ts [--days 60] [--out data]
//   OURA_TOKEN_FILE=/path/to/token node scripts/oura-sync.ts
//
// The token is sent as a Bearer token (an Oura personal access token or an OAuth access token).
// New records are merged into the existing oura.json, and oura.json is added to data/manifest.json
// so the dashboard loads it. Requires Node 18+ (built-in fetch). No dependencies.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OURA_KEYS, ouraKey, type OuraCollections, type OuraRecord } from "../shared/parsers.ts";

const API = "https://api.ouraring.com/v2/usercollection";

function args() {
  const out = { days: 60, out: "data" };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--days") out.days = Math.max(1, parseInt(a[++i], 10) || 60);
    else if (a[i] === "--out") out.out = a[++i];
    else if (a[i] === "-h" || a[i] === "--help") {
      console.log("Usage: OURA_TOKEN=... node scripts/oura-sync.ts [--days N] [--out DIR]");
      process.exit(0);
    }
  }
  return out;
}

async function token(): Promise<string> {
  if (process.env.OURA_TOKEN) return process.env.OURA_TOKEN.trim();
  if (process.env.OURA_TOKEN_FILE) return (await readFile(process.env.OURA_TOKEN_FILE, "utf8")).trim();
  console.error("Set OURA_TOKEN (or OURA_TOKEN_FILE) to your Oura access token.");
  process.exit(2);
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

async function fetchCollection(name: string, start: string, end: string, tok: string): Promise<OuraRecord[]> {
  const rows: OuraRecord[] = [];
  let next: string | null = null;
  do {
    const u = new URL(`${API}/${name}`);
    u.searchParams.set("start_date", start);
    u.searchParams.set("end_date", end);
    if (next) u.searchParams.set("next_token", next);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" } });
    if (res.status === 401 || res.status === 403) throw new Error(`${name}: Oura rejected the token (HTTP ${res.status}). Check that it is valid and has access to this data.`);
    if (res.status === 429) throw new Error(`${name}: rate limited by Oura (HTTP 429). Try again later.`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
    const body = await res.json() as { data?: OuraRecord[]; next_token?: string | null };
    rows.push(...(body.data || []));
    next = body.next_token || null;
  } while (next);
  return rows;
}

async function readJSON<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return fallback; }
}

async function writeAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 1) + "\n");
  await rename(tmp, path);
}

async function main() {
  const { days, out } = args();
  const tok = await token();
  const now = new Date();
  const start = isoDay(new Date(now.getTime() - days * 86400000));
  const end = isoDay(new Date(now.getTime() + 86400000)); // +1 day so today is included

  await mkdir(out, { recursive: true });
  const file = join(out, "oura.json");
  const existing = await readJSON<OuraCollections>(file, {});
  const merged: OuraCollections & { source: string; fetched_at: string } = { source: "oura", fetched_at: now.toISOString() };

  for (const c of OURA_KEYS) {
    const fresh = await fetchCollection(c, start, end, tok);
    const byKey = new Map<string, OuraRecord>();
    for (const r of [...(existing[c] || []), ...fresh]) byKey.set(ouraKey(r), r);
    const rows = [...byKey.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
    merged[c] = rows;
    console.log(`${c}: ${fresh.length} fetched, ${rows.length} stored`);
  }
  await writeAtomic(file, merged);

  const manPath = join(out, "manifest.json");
  const manifest = await readJSON<string[]>(manPath, []);
  if (!manifest.includes("oura.json")) { manifest.push("oura.json"); await writeAtomic(manPath, manifest); }
  console.log(`Wrote ${file}`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
