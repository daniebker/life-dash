import { DAY, naive } from "../../../shared/parsers.ts";

export const dayStart = (t: number): number => Math.floor(t / DAY) * DAY;
export const fmtDay = (t: number): string => new Date(t * 1000).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" });
export const fmtDate = (t: number): string => new Date(t * 1000).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
export const fmtClock = (t: number): string => new Date(t * 1000).toISOString().slice(11, 16);
export const fmtH = (s: number): string => { const h = s / 3600; return h >= 10 ? h.toFixed(0) + "h" : h.toFixed(1) + "h"; };
export const fmtHM = (s: number): string => { const m = Math.round(s / 60); return (m >= 60 ? Math.floor(m / 60) + "h " : "") + (m % 60) + "m"; };
export const isWeekend = (t: number): boolean => { const d = new Date(t * 1000).getUTCDay(); return d === 0 || d === 6; };
export const dayOfMonth = (t: number): number => new Date(t * 1000).getUTCDate();
export const minutesToClock = (m: number): string => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(Math.round(m % 60)).padStart(2, "0");
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function ago(t: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago`
    : new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// ISO timestamp -> naive local seconds (the dashboard's time base). Date-only values stay on their calendar day.
export function isoToNaive(s: string | undefined): number {
  if (!s) return NaN;
  if (/^\d{4}-\d\d-\d\d$/.test(s)) return naive(s + " 00:00");
  const d = new Date(s); const t = d.getTime();
  return Number.isNaN(t) ? NaN : Math.floor(t / 1000) - d.getTimezoneOffset() * 60;
}
export const todayNaive = (): number => dayStart(isoToNaive(new Date().toISOString()));
