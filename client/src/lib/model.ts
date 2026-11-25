/* Turns the raw sources (local files or the server's /api/data) into what the panels draw. Pure functions. */
import {
  DAY, naive, dkey, wallClock,
  type Sources, type TimeEntry, type Checkin, type Habit, type MwTask, type MwProject, type MwArea,
} from "../../../shared/parsers.ts";
import { dayStart, isoToNaive } from "./format.ts";
import { OPEN_STATUSES } from "./groups.ts";

export interface OuraDay { day: string; sleepScore?: number; readiness?: number; activity?: number; steps?: number; kcal?: number; temp?: number }
export interface OuraNight {
  day: string; start: number; end: number; asleep?: number; inBed?: number; eff?: number;
  hrv?: number; low?: number; deep?: number; rem?: number;
}
export interface Task extends MwTask { doneT: number; dueT: number; createdT: number }

export interface Model {
  log: TimeEntry[];
  checkins: Checkin[];
  habits: Habit[];
  acts: string[];
  first: number | null;
  last: number | null;
  oura: { days: Record<string, OuraDay>; sleep: Map<string, OuraNight>; any: boolean };
  mw: { tasks: Task[]; projects: Map<string, MwProject>; areas: Map<string, MwArea>; any: boolean };
}

export const emptySources = (): Sources => ({ log: [], checkins: [], habits: [], activities: [], oura: [], mindwtr: [] });

// newest copy of each record (by updatedAt) wins across files
function newest<T extends { id: string; updatedAt?: string }>(lists: T[][]): Map<string, T> {
  const m = new Map<string, T>();
  for (const l of lists) for (const r of l || []) {
    const p = m.get(r.id);
    if (!p || String(r.updatedAt || "") >= String(p.updatedAt || "")) m.set(r.id, r);
  }
  return m;
}

export function buildModel(src: Sources): Model {
  const logMap = new Map<string, TimeEntry>(), chkMap = new Map<string, Checkin>(), habits: Habit[] = [], acts = new Set(src.activities);
  const oDays: Record<string, OuraDay> = {}, oSleep = new Map<string, OuraNight>();
  const od = (day: string) => (oDays[day] ||= { day });
  for (const r of src.log) logMap.set(r.s + "|" + r.act, r);
  for (const c of src.checkins) chkMap.set(c.t + c.core + c.mid + c.leaf, c);
  for (const h of src.habits) {
    const ex = habits.find(x => x.name === h.name);
    if (ex) Object.assign(ex.days, h.days); else habits.push({ ...h, days: { ...h.days } });
  }
  for (const c of src.oura) {
    for (const r of c.daily_sleep || []) if (r.score != null) od(r.day).sleepScore = r.score;
    for (const r of c.daily_readiness || []) { const d = od(r.day); if (r.score != null) d.readiness = r.score; if (r.temperature_deviation != null) d.temp = r.temperature_deviation; }
    for (const r of c.daily_activity || []) { const d = od(r.day); if (r.score != null) d.activity = r.score; if (r.steps != null) d.steps = r.steps; if (r.active_calories != null) d.kcal = r.active_calories; }
    for (const r of c.sleep || []) {
      if (r.type && r.type !== "long_sleep") continue; // ignore naps and rests
      const s: OuraNight = {
        day: r.day, start: wallClock(r.bedtime_start), end: wallClock(r.bedtime_end), asleep: r.total_sleep_duration, inBed: r.time_in_bed,
        eff: r.efficiency, hrv: r.average_hrv, low: r.lowest_heart_rate, deep: r.deep_sleep_duration, rem: r.rem_sleep_duration,
      };
      const prev = oSleep.get(r.day);
      if (!prev || (s.asleep || 0) > (prev.asleep || 0)) oSleep.set(r.day, s);
    }
  }
  const log = [...logMap.values()].sort((a, b) => a.s - b.s);
  const checkins = [...chkMap.values()].sort((a, b) => a.t - b.t);
  for (const r of log) acts.add(r.act);

  const tasks: Task[] = [...newest(src.mindwtr.map(x => x.tasks)).values()]
    .map(t => ({ ...t, doneT: isoToNaive(t.completedAt), dueT: isoToNaive(t.dueDate), createdT: isoToNaive(t.createdAt) }));
  const mw = { tasks, projects: newest(src.mindwtr.map(x => x.projects)), areas: newest(src.mindwtr.map(x => x.areas)), any: tasks.length > 0 };

  // span of days covered by the data
  const ts: number[] = [];
  for (const r of log) ts.push(r.s, r.e - 1);
  for (const c of checkins) ts.push(c.t);
  for (const h of habits) for (const k of Object.keys(h.days)) ts.push(naive(k + " 12:00"));
  for (const k of [...Object.keys(oDays), ...oSleep.keys()]) ts.push(naive(k + " 12:00"));
  // tasks only set the range when nothing else does (their history can span years): then the last 90 days of completions
  if (!ts.length) {
    const done = tasks.map(t => t.doneT).filter(Number.isFinite);
    if (done.length) { const hi = Math.max(...done); ts.push(Math.max(Math.min(...done), hi - 89 * DAY), hi); }
  }
  const first = ts.length ? dayStart(Math.min(...ts)) : null, last = ts.length ? dayStart(Math.max(...ts)) : null;
  return { log, checkins, habits, acts: [...acts], first, last, mw, oura: { days: oDays, sleep: oSleep, any: Object.keys(oDays).length + oSleep.size > 0 } };
}

/* ---------- the selected date range ---------- */
export type Range = 0 | 7 | 14 | 30; // 0 = all

export interface Piece extends TimeEntry { cs: number; ce: number } // a log entry clipped to one day

export interface View {
  days: number[];
  lo: number;
  hi: number;
  pieces: Map<number, Piece[]>;
  byAct: Record<string, number>;
  perDayAct: Map<number, Record<string, number>>;
  sleeps: TimeEntry[];
  checkins: Checkin[];
}

export function rangeDays(m: Model, range: Range): number[] {
  if (m.first == null || m.last == null) return [];
  const from = range ? Math.max(m.first, m.last - (range - 1) * DAY) : m.first;
  const out: number[] = [];
  for (let t = from; t <= m.last; t += DAY) out.push(t);
  return out;
}

// split log rows into per-day pieces clipped to [day, day+1)
function piecesFor(m: Model, day: number): Piece[] {
  const end = day + DAY, out: Piece[] = [];
  for (const r of m.log) { if (r.e <= day || r.s >= end) continue; out.push({ ...r, cs: Math.max(r.s, day), ce: Math.min(r.e, end) }); }
  return out;
}

export function buildView(m: Model, range: Range): View {
  const days = rangeDays(m, range);
  const lo = days[0] ?? 0, hi = days.length ? days[days.length - 1] + DAY : 0;
  const pieces = new Map<number, Piece[]>(), byAct: Record<string, number> = {}, perDayAct = new Map<number, Record<string, number>>();
  for (const d of days) {
    const ps = piecesFor(m, d), per: Record<string, number> = {};
    for (const p of ps) { const s = p.ce - p.cs; byAct[p.act] = (byAct[p.act] || 0) + s; per[p.act] = (per[p.act] || 0) + s; }
    pieces.set(d, ps); perDayAct.set(d, per);
  }
  const sleeps = m.log.filter(r => r.act === "Sleep" && dayStart(r.e) >= lo && dayStart(r.e) < hi);
  const checkins = m.checkins.filter(c => c.t >= lo && c.t < hi);
  return { days, lo, hi, pieces, byAct, perDayAct, sleeps, checkins };
}

/* ---------- helpers used by several panels ---------- */
export function habitStats(m: Model, days: number[]): { hit: number; possible: number } {
  let hit = 0, possible = 0;
  const ks = days.map(dkey);
  for (const h of m.habits) {
    if (!ks.some(k => h.days[k])) continue;
    const firstK = Object.keys(h.days).sort()[0];
    for (const k of ks) if (k >= firstK) { possible++; if ((h.days[k] || 0) >= h.target) hit++; }
  }
  return { hit, possible };
}

export const activityAt = (m: Model, t: number): string => m.log.find(r => r.s <= t && t < r.e)?.act || "Not logged";

export function taskStats(m: Model, v: View, today: number) {
  const done = m.mw.tasks.filter(t => t.doneT >= v.lo && t.doneT < v.hi).sort((a, b) => b.doneT - a.doneT);
  const open = m.mw.tasks.filter(t => OPEN_STATUSES.has(t.status));
  const overdue = open.filter(t => t.dueT < today);
  return { done, open, overdue };
}
