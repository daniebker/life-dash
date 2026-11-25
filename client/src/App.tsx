import { useCallback, useEffect, useMemo, useState } from "react";
import type { Me, UploadRow } from "../../shared/api.ts";
import type { Sources } from "../../shared/parsers.ts";
import * as api from "./lib/api.ts";
import { type Range, buildModel, buildView, emptySources } from "./lib/model.ts";
import { type StoredFile, addFile, loadBundledFiles, loadFiles, saveFiles, sourcesFromFiles } from "./lib/localFiles.ts";
import { useStored } from "./lib/hooks.ts";
import { DayLedger } from "./components/DayLedger.tsx";
import { DropZone, type Message, noMessage } from "./components/DropZone.tsx";
import { HabitsPanel } from "./components/HabitsPanel.tsx";
import { Header } from "./components/Header.tsx";
import { Kpis } from "./components/Kpis.tsx";
import { LoginForm } from "./components/LoginForm.tsx";
import { LogTable } from "./components/LogTable.tsx";
import { MoodPanels } from "./components/MoodPanels.tsx";
import { OuraPanel } from "./components/OuraPanel.tsx";
import { TasksPanel } from "./components/TasksPanel.tsx";
import { SleepPanel, TimePanel } from "./components/TimeAndSleep.tsx";
import { TooltipLayer } from "./components/Tooltip.tsx";
import { type Note, type ServerCtx, noNote } from "./components/server.ts";

/* The page runs in one of these modes:
   - "local":  no server (static hosting, file://); files are parsed in the browser and kept in localStorage
   - "login":  a server, signed out (or first-run setup)
   - "server": a server, signed in; data comes from the API */
type Mode =
  | { kind: "loading" }
  | { kind: "local" }
  | { kind: "login"; setup: boolean; needCode: boolean; message: string }
  | { kind: "server"; me: Me; data: Sources; uploads: UploadRow[] };

const OURA_RETURN: Record<string, Note> = {
  connected: { tone: "ok", text: "Oura connected. Fetching your history in the background…" },
  denied: { tone: "err", text: "Oura access wasn't granted." },
  error: { tone: "err", text: "Connecting Oura failed. Try again." },
  not_configured: { tone: "err", text: "Oura sign-in isn't set up on the server yet." },
};
const SESSION_ENDED = "Your session ended. Sign in again.";
const isRange = (v: unknown): v is Range => v === 0 || v === 7 || v === 14 || v === 30;

export function App() {
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [range, setRange] = useStored<Range>("lifedash.range", 0, isRange);
  const [uploadMsg, setUploadMsg] = useState<Message>(noMessage);
  const [ouraNote, setOuraNote] = useState<Note>(noNote);

  const showLogin = useCallback(async (message = "") => {
    const p = await api.probe();
    if (p.kind === "signed-out") setMode({ kind: "login", setup: p.info.setupRequired, needCode: p.info.setupCodeRequired, message });
    else setMode({ kind: "login", setup: false, needCode: false, message });
  }, []);

  // Load everything for the signed-in user.
  const loadServer = useCallback(async (meArg?: Me) => {
    const [me, d, u] = await Promise.all([meArg ? Promise.resolve(null) : api.getMe(), api.getData(), api.getUploads()]);
    if (d.status === 401 || me?.status === 401) return showLogin(SESSION_ENDED);
    const user = meArg ?? me?.json;
    if (!user || !d.json) return;
    setMode({ kind: "server", me: user, data: d.json, uploads: u.json ?? [] });
  }, [showLogin]);

  /* ---------- boot ---------- */
  useEffect(() => {
    void (async () => {
      const p = await api.probe();
      if (p.kind === "none") {
        let stored = loadFiles();
        if (!stored.length) { stored = await loadBundledFiles(); saveFiles(stored); }
        setFiles(stored);
        setMode({ kind: "local" });
        return;
      }
      // returning from Oura's sign-in page
      const ret = new URLSearchParams(location.search).get("oura");
      if (ret) { history.replaceState(null, "", location.pathname); setOuraNote(OURA_RETURN[ret] ?? noNote); }
      if (p.kind === "signed-out") {
        setMode({ kind: "login", setup: p.info.setupRequired, needCode: p.info.setupCodeRequired, message: ret && !p.info.setupRequired ? "Sign in to finish connecting Oura." : "" });
        return;
      }
      await loadServer(p.me);
    })();
  }, [loadServer]);

  /* ---------- while an Oura sync runs (e.g. the first backfill), check every 3 s and reload when it's done ---------- */
  const me = mode.kind === "server" ? mode.me : null;
  const ouraBusy = Boolean(me && (me.oura.syncing || (me.oura.connected && me.oura.status === "active" && !me.oura.lastSyncAt)));
  useEffect(() => {
    if (!ouraBusy) return;
    let rounds = 60;
    const timer = setInterval(async () => {
      const r = await api.getMe();
      if (r.status === 401) { clearInterval(timer); void showLogin(SESSION_ENDED); return; }
      const fresh = r.json;
      if (!fresh) return;
      const still = fresh.oura.syncing || (fresh.oura.connected && fresh.oura.status === "active" && !fresh.oura.lastSyncAt);
      if (!still || --rounds <= 0) { clearInterval(timer); void loadServer(fresh); }
    }, 3000);
    return () => clearInterval(timer);
  }, [ouraBusy, loadServer, showLogin]);

  /* ---------- data ---------- */
  const sources = useMemo<Sources>(() =>
    mode.kind === "server" ? mode.data : mode.kind === "local" ? sourcesFromFiles(files) : emptySources(), [mode, files]);
  const model = useMemo(() => buildModel(sources), [sources]);
  const view = useMemo(() => buildView(model, range), [model, range]);

  /* ---------- uploads ---------- */
  const onFiles = useCallback(async (list: File[]) => {
    if (mode.kind === "local") {
      let next = files; const bad: string[] = [];
      for (const f of list) { const r = addFile(next, f.name, await f.arrayBuffer(), f.lastModified); if (r) next = r; else bad.push(f.name); }
      setFiles(next); saveFiles(next);
      setUploadMsg(bad.length ? { tone: "err", lines: [`Couldn't recognise ${bad.join(", ")}. Expected a time log, check-ins, habits, activity list, Oura or Mindwtr file.`] } : noMessage);
      return;
    }
    if (mode.kind !== "server") return; // signed out: ignore drops
    setUploadMsg({ tone: "", lines: [`Uploading ${list.length} file${list.length > 1 ? "s" : ""}…`] });
    const lines: string[] = []; let failed = false;
    for (const f of list) {
      try {
        const r = await api.upload(f);
        if (r.status === 401) return showLogin(SESSION_ENDED);
        if (!r.ok || !r.json) { failed = true; lines.push(r.error ?? `${f.name}: upload failed (HTTP ${r.status}).`); continue; }
        const u = r.json.upload;
        lines.push(r.json.duplicate
          ? `${f.name}: already uploaded on ${new Date(u.created_at * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, nothing added.`
          : `${f.name}: ${u.added} new${u.updated ? `, ${u.updated} updated` : ""}, ${u.unchanged} already stored.`);
      } catch { failed = true; lines.push(`${f.name}: couldn't reach the server.`); }
    }
    await loadServer(mode.me);
    setUploadMsg({ tone: failed ? "err" : "ok", lines });
  }, [mode, files, loadServer, showLogin]);

  const removeFile = (i: number) => { const next = files.filter((_, j) => j !== i); setFiles(next); saveFiles(next); };

  /* ---------- server context for the panels ---------- */
  const server: ServerCtx | null = useMemo(() => mode.kind !== "server" ? null : {
    me: mode.me,
    updateMe: patch => setMode(m => (m.kind === "server" ? { ...m, me: { ...m.me, ...patch } } : m)),
    reload: () => loadServer(),
    signedOut: () => void showLogin(SESSION_ENDED),
  }, [mode, loadServer, showLogin]);

  const signOut = async () => { await api.logout().catch(() => null); setUploadMsg(noMessage); void showLogin(); };

  /* ---------- render ---------- */
  if (mode.kind === "loading") return null;
  if (mode.kind === "login") {
    return <LoginForm setupMode={mode.setup} needCode={mode.needCode} message={mode.message}
      onSignedIn={() => void loadServer()} onSetupDone={msg => setMode({ kind: "login", setup: false, needCode: false, message: msg })} />;
  }
  return (
    <>
      <div className="wrap" id="app">
        <Header days={view.days} range={range} onRange={setRange} username={me?.user.username} onSignOut={signOut} />
        <DropZone onFiles={onFiles} serverMode={mode.kind === "server"} message={uploadMsg}
          uploads={mode.kind === "server" ? mode.uploads : undefined} files={mode.kind === "local" ? files : undefined} onRemove={removeFile} />
        <Kpis model={model} view={view} />
        <DayLedger model={model} view={view} />
        <div className="grid2">
          <TimePanel model={model} view={view} />
          <SleepPanel view={view} />
        </div>
        <OuraPanel model={model} view={view} server={server} initialNote={ouraNote} />
        <TasksPanel model={model} view={view} server={server} />
        <HabitsPanel model={model} view={view} />
        <MoodPanels model={model} view={view} />
        <LogTable model={model} view={view} />
      </div>
      <TooltipLayer />
    </>
  );
}
