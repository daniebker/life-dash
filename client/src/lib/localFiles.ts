/* Static mode (no server): files are parsed in the browser and kept in localStorage. */
import {
  detect, parseLog, parseCheckins, parseActivities, parseHabits, ouraCollections, parseMindwtrText, slimMindwtr,
  type FileKind, type Sources,
} from "../../../shared/parsers.ts";
import { emptySources } from "./model.ts";

export interface StoredFile { name: string; kind: FileKind; data: string; year?: number } // data: text, or base64 for habits

const STORE_KEY = "lifedash.files.v1";

function b64enc(buf: ArrayBuffer): string { let s = ""; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
function b64dec(str: string): ArrayBuffer { const s = atob(str); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b.buffer; }

export function loadFiles(): StoredFile[] {
  try { const s = localStorage.getItem(STORE_KEY); return s ? (JSON.parse(s) as StoredFile[]) || [] : []; } catch { return []; }
}
export function saveFiles(files: StoredFile[]): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(files)); } catch { /* storage unavailable: keep in memory */ }
}

/* Adds (or replaces, by name) one file. Returns the new list, or null if the file isn't recognised. */
export function addFile(files: StoredFile[], name: string, buf: ArrayBuffer, lastModified?: number): StoredFile[] | null {
  const kind = detect(name, buf);
  if (!kind) return null;
  const text = () => new TextDecoder().decode(buf);
  const rec: StoredFile = { name, kind, data: "" };
  if (kind === "habits") { rec.data = b64enc(buf); rec.year = new Date(lastModified || Date.now()).getFullYear(); }
  else if (kind === "mindwtr") rec.data = JSON.stringify(parseMindwtrText(text())); // drop settings (may hold API keys)
  else rec.data = text();
  let next = files.filter(f => !(f.name === name && f.kind === kind));
  if (kind === "habits") next = next.filter(f => !(f.kind === "habits" && f.year === rec.year));
  return [...next, rec];
}

export function sourcesFromFiles(files: StoredFile[]): Sources {
  const src = emptySources();
  for (const f of files) {
    try {
      if (f.kind === "log") src.log.push(...parseLog(f.data));
      else if (f.kind === "checkins") src.checkins.push(...parseCheckins(f.data));
      else if (f.kind === "activities") src.activities.push(...parseActivities(f.data));
      else if (f.kind === "habits") src.habits.push(...parseHabits(b64dec(f.data), f.year ?? new Date().getFullYear()));
      else if (f.kind === "oura") { const c = ouraCollections(JSON.parse(f.data)); if (c) src.oura.push(c); }
      else if (f.kind === "mindwtr") src.mindwtr.push(slimMindwtr(parseMindwtrText(f.data)));
    } catch (e) { console.warn("Could not parse", f.name, e); }
  }
  return src;
}

/* Optional: files listed in data/manifest.json next to the page are loaded on first visit (names ending .b64 are base64). */
export async function loadBundledFiles(): Promise<StoredFile[]> {
  let files: StoredFile[] = [];
  try {
    const manifest = await (await fetch("data/manifest.json")).json() as string[];
    for (const n of manifest) {
      const r = await fetch("data/" + n);
      if (!r.ok) continue;
      const buf = n.endsWith(".b64") ? b64dec((await r.text()).trim()) : await r.arrayBuffer();
      files = addFile(files, n.replace(/\.b64$/, ""), buf, Date.now()) ?? files;
    }
  } catch { /* no bundled data */ }
  return files;
}
