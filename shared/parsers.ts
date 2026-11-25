/* Life Dash file parsers and data types, shared by the dashboard (bundled by Vite) and the server (run by Node).
   Times are "naive" seconds: wall-clock time treated as UTC, so no timezone shifts. */

export const DAY = 86400;

/* ---------- types ---------- */
export type FileKind = "log" | "checkins" | "habits" | "activities" | "oura" | "mindwtr";

export interface TimeEntry { s: number; e: number; act: string }
export interface Checkin { t: number; core: string; mid: string; leaf: string }
export interface Habit { name: string; target: number; days: Record<string, number> }

export type OuraKey = "daily_sleep" | "daily_readiness" | "daily_activity" | "sleep";
export type OuraRecord = Record<string, any> & { id?: string; day: string };
export type OuraCollections = Partial<Record<OuraKey, OuraRecord[]>>;

export type MindwtrKey = "tasks" | "projects" | "sections" | "areas";
export type MindwtrRecord = Record<string, any> & { id: string; updatedAt?: string; deletedAt?: string; purgedAt?: string };
export type MindwtrData = Record<MindwtrKey, MindwtrRecord[]>;

export interface MwTask {
  id: string; title: string; status: string; projectId?: string; areaId?: string; contexts?: string[]; tags?: string[];
  priority?: string; createdAt?: string; updatedAt?: string; completedAt?: string; dueDate?: string; startTime?: string;
}
export interface MwProject { id: string; title: string; status: string; areaId?: string; color?: string; createdAt?: string; updatedAt?: string }
export interface MwArea { id: string; name: string; color?: string }
export interface MindwtrSlim { tasks: MwTask[]; projects: MwProject[]; areas: MwArea[] }

/* What the dashboard is built from, whether it comes from local files or the server's /api/data. */
export interface Sources {
  log: TimeEntry[];
  checkins: Checkin[];
  habits: Habit[];
  activities: string[];
  oura: OuraCollections[];
  mindwtr: MindwtrSlim[];
}

/* ---------- time ---------- */
export function naive(s: unknown): number {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?/.exec(String(s).trim());
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
}
export const dkey = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);
// keep the wall-clock part of an ISO timestamp with offset (Oura uses the ring's local time)
export const wallClock = (s: unknown): number => typeof s === "string" ? naive(s.slice(0, 19)) : NaN;

const toArrayBuffer = (b: ArrayBuffer | Uint8Array): ArrayBuffer =>
  b instanceof ArrayBuffer ? b : (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const stripBom = (s: string) => s.replace(/^\uFEFF/, "");

/* ---------- detection ---------- */
export function detect(_name: string, input: ArrayBuffer | Uint8Array): FileKind | null {
  const buf = toArrayBuffer(input);
  const head = new Uint8Array(buf.slice(0, 4));
  if (String.fromCharCode(...head) === "HBT1") return "habits";
  const text = new TextDecoder().decode(buf.slice(0, 2000));
  if (/^\s*[{[]/.test(text)) {
    try {
      const j: unknown = JSON.parse(stripBom(new TextDecoder().decode(buf)));
      if (isMindwtr(j)) return "mindwtr";
      if (ouraCollections(j)) return "oura";
    } catch { /* not JSON */ }
    return null;
  }
  if (/^\s*start_ts\s*,\s*end_ts/i.test(text) || /start\s*,\s*end\s*,\s*activity/i.test(text)) return "log";
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d,[A-Za-z]/m.test(text)) return "checkins";
  if (!/,/.test(text) && /^[\w &/-]+$/m.test(text)) return "activities";
  return null;
}

/* ---------- CSV files ---------- */
export function parseCSVLine(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out;
}

/* Time log CSV -> [{s, e, act}]. tzOffsetSec is only used when the wall-clock start/end columns are missing. */
export function parseLog(text: string, tzOffsetSec?: number): TimeEntry[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const hdr = parseCSVLine(lines.shift()!).map(h => h.trim().toLowerCase());
  const ix = (k: string) => hdr.indexOf(k);
  const tz = tzOffsetSec ?? -new Date().getTimezoneOffset() * 60;
  const rows: TimeEntry[] = [];
  for (const l of lines) {
    const c = parseCSVLine(l);
    let s = ix("start") >= 0 ? naive(c[ix("start")]) : NaN;
    let e = ix("end") >= 0 ? naive(c[ix("end")]) : NaN;
    if (isNaN(s) && ix("start_ts") >= 0) { s = +c[ix("start_ts")] + tz; e = +c[ix("end_ts")] + tz; }
    const act = (c[ix("activity")] || "Other").trim() || "Other";
    if (!isNaN(s) && !isNaN(e) && e > s) rows.push({ s, e, act });
  }
  return rows;
}

/* Check-ins CSV (no header): time, core feeling, feeling, sub-feeling */
export function parseCheckins(text: string): Checkin[] {
  const out: Checkin[] = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim()) continue;
    const c = parseCSVLine(l); const t = naive(c[0]);
    if (!isNaN(t)) out.push({ t, core: (c[1] || "").trim(), mid: (c[2] || "").trim(), leaf: (c[3] || "").trim() });
  }
  return out;
}

export const parseActivities = (text: string): string[] => [...new Set(text.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];

/* habits.dat (HBT1): header = magic[4], u16 version, u16 recordSize, u32 count.
   record = name[24] (NUL padded), u16 daily target @24, then one byte per day-of-year where day d sits at offset 26+d.
   Bytes 26..29 hold a 4-byte field (id/checksum), so Jan 1-4 are not read. */
export function parseHabits(input: ArrayBuffer | Uint8Array, year: number): Habit[] {
  const buf = toArrayBuffer(input);
  const dv = new DataView(buf), bytes = new Uint8Array(buf);
  const rs = dv.getUint16(6, true), n = dv.getUint32(8, true);
  const jan1 = Date.UTC(year, 0, 1) / 1000;
  const ndays = (Date.UTC(year + 1, 0, 1) / 1000 - jan1) / DAY;
  const out: Habit[] = [];
  for (let i = 0; i < n; i++) {
    const off = 12 + i * rs; if (off + rs > bytes.length) break;
    let name = ""; for (let j = 0; j < 24 && bytes[off + j]; j++) name += String.fromCharCode(bytes[off + j]);
    const target = dv.getUint16(off + 24, true) || 1;
    const days: Record<string, number> = {};
    for (let d = 4; d < Math.min(ndays, rs - 26); d++) { const v = bytes[off + 26 + d]; if (v) days[dkey(jan1 + d * DAY)] = v; }
    out.push({ name: name.replace(/_/g, " "), target, days });
  }
  return out;
}

/* ---------- Oura ---------- */
/* {source:"oura", daily_sleep:[], daily_readiness:[], daily_activity:[], sleep:[]} or a raw API v2 response {data:[...]},
   whose rows are classified by their fields. */
export const OURA_KEYS: OuraKey[] = ["daily_sleep", "daily_readiness", "daily_activity", "sleep"];
export function classifyOuraRow(r: any): OuraKey | null {
  if (!r || typeof r !== "object" || !r.day) return null;
  if ("bedtime_start" in r) return "sleep";
  if ("steps" in r || "active_calories" in r) return "daily_activity";
  if ("temperature_deviation" in r || (r.contributors && "hrv_balance" in r.contributors)) return "daily_readiness";
  if (r.contributors && ("deep_sleep" in r.contributors || "rem_sleep" in r.contributors)) return "daily_sleep";
  return null;
}
export function ouraCollections(j: any): OuraCollections | null {
  if (!j || typeof j !== "object") return null;
  const out: OuraCollections = {}; let n = 0;
  for (const k of OURA_KEYS) if (Array.isArray(j[k])) { out[k] = j[k]; n += j[k].length + 1; }
  if (Array.isArray(j.data)) for (const r of j.data) { const k = classifyOuraRow(r); if (k) { (out[k] ||= []).push(r); n++; } }
  return n ? out : null;
}
// stable identity of an Oura record across uploads and syncs
export const ouraKey = (r: OuraRecord): string => r.id ? String(r.id) : `${r.day}|${r.bedtime_start || ""}`;

/* ---------- Mindwtr ---------- */
/* Mindwtr (GTD app) data.json: { tasks, projects, sections, areas, people?, settings }.
   Only tasks, projects, sections and areas are kept; settings are dropped (they can hold API keys). */
export const MINDWTR_KEYS: MindwtrKey[] = ["tasks", "projects", "sections", "areas"];
export function isMindwtr(j: any): boolean {
  return Boolean(j) && typeof j === "object" && !Array.isArray(j) && Array.isArray(j.tasks)
    && (Array.isArray(j.projects) || Array.isArray(j.areas) || Boolean(j.settings && typeof j.settings === "object"));
}
export function parseMindwtr(j: any): MindwtrData {
  const out = {} as MindwtrData;
  for (const k of MINDWTR_KEYS) out[k] = (Array.isArray(j[k]) ? j[k] : []).filter((r: any) => r && typeof r === "object" && typeof r.id === "string" && r.id);
  return out;
}
export const parseMindwtrText = (text: string): MindwtrData => parseMindwtr(JSON.parse(stripBom(text)));

// The fields the dashboard uses, without deleted records.
export function slimMindwtr(p: Partial<MindwtrData>): MindwtrSlim {
  const live = (r: MindwtrRecord) => !r.deletedAt && !r.purgedAt;
  const pick = (r: MindwtrRecord, keys: string[]) => { const o: Record<string, unknown> = {}; for (const k of keys) if (r[k] != null) o[k] = r[k]; return o; };
  return {
    tasks: (p.tasks || []).filter(live).map(r => pick(r, ["id", "title", "status", "projectId", "areaId", "contexts", "tags", "priority", "createdAt", "updatedAt", "completedAt", "dueDate", "startTime"]) as unknown as MwTask),
    projects: (p.projects || []).filter(live).map(r => pick(r, ["id", "title", "status", "areaId", "color", "createdAt", "updatedAt"]) as unknown as MwProject),
    areas: (p.areas || []).filter(live).map(r => pick(r, ["id", "name", "color"]) as unknown as MwArea),
  };
}
