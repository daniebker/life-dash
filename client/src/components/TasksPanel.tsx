import { useState, type FormEvent } from "react";
import { type Model, type View, taskStats } from "../lib/model.ts";
import * as api from "../lib/api.ts";
import { ago, dayStart, fmtClock, fmtDate, fmtDay, plural, todayNaive } from "../lib/format.ts";
import { STATUS_LABELS } from "../lib/groups.ts";
import { Bars, ColumnChart, sparseDayLabels } from "./charts.tsx";
import { type Note, type ServerCtx, noNote } from "./server.ts";

function MindwtrControls({ server }: { server: ServerCtx }) {
  const m = server.me.mindwtr;
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState<Note>(noNote);
  const [busy, setBusy] = useState(false);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setNote({ tone: "", text: "Fetching data.json…" });
    try {
      const r = await api.mindwtrConnect(url, username, password);
      if (r.status === 401) return server.signedOut();
      if (!r.ok || !r.json) { setNote({ tone: "err", text: r.error ?? "Couldn't connect." }); return; }
      server.updateMe({ mindwtr: r.json.mindwtr });
      await server.reload();
      setPassword("");
      setNote({ tone: "ok", text: `Connected: ${r.json.mindwtr.tasks} tasks loaded. It syncs in the background from now on.` });
    } catch {
      setNote({ tone: "err", text: "Couldn't reach the server." });
    } finally { setBusy(false); }
  }

  async function sync() {
    setBusy(true);
    const r = await api.mindwtrSync();
    if (r.status === 401) { setBusy(false); return server.signedOut(); }
    if (r.json) { server.updateMe({ mindwtr: r.json.mindwtr }); await server.reload(); }
    setBusy(false);
    if (!r.ok || !r.json) { setNote({ tone: "err", text: r.error ?? "That didn't work." }); return; }
    const j = r.json;
    setNote({ tone: "ok", text: j.unchanged ? "No changes since the last sync." : `Synced: ${j.added ?? 0} new, ${j.updated ?? 0} updated, ${j.removed ?? 0} removed.` });
  }

  async function disconnect() {
    setBusy(true);
    const r = await api.mindwtrDisconnect();
    setBusy(false);
    if (r.status === 401) return server.signedOut();
    if (!r.ok || !r.json) { setNote({ tone: "err", text: r.error ?? "That didn't work." }); return; }
    server.updateMe({ mindwtr: r.json.mindwtr });
    setNote({ tone: "ok", text: "Disconnected. Tasks already synced are kept." });
  }

  const msg = <span className={`msg${note.tone ? " " + note.tone : ""}`} id="mwMsg">{note.text}</span>;
  if (!m.connected) {
    return (
      <div className="octl" id="mwCtl">
        <form className="mwform" onSubmit={connect}>
          <input id="mwUrl" aria-label="WebDAV address" placeholder="WebDAV folder, e.g. https://cloud.example.com/remote.php/dav/files/you/Mindwtr/" required value={url} onChange={e => setUrl(e.target.value)} />
          <input id="mwUser" aria-label="WebDAV username" placeholder="Username" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} />
          <input id="mwPass" aria-label="WebDAV password" type="password" placeholder="Password or app password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
          <button className="ghost primary" type="submit" id="mwBtn" disabled={busy}>Connect Mindwtr</button>
        </form>
        <span className="state">Use the WebDAV folder from Mindwtr's sync settings (data.json is added), or the full address of the file. For Nextcloud, create an app password.</span>
        {msg}
      </div>
    );
  }
  let where = m.url ?? "";
  try { const u = new URL(where); where = u.host + decodeURIComponent(u.pathname); } catch { /* show as is */ }
  return (
    <div className="octl" id="mwCtl">
      <button type="button" className="ghost" data-mw="sync" disabled={busy || m.syncing} onClick={sync}>Sync now</button>
      <button type="button" className="ghost" data-mw="disconnect" disabled={busy} onClick={disconnect}>Disconnect</button>
      <span className="state">
        {m.syncing ? <><span className="dot on" />Syncing…</>
          : <><span className={`dot ${m.lastError ? "warn" : "on"}`} />Mindwtr via {where} · {m.lastSyncAt ? "synced " + ago(m.lastSyncAt) : "not synced yet"}{m.lastError ? ` · ${m.lastError}` : ""}</>}
      </span>
      {msg}
    </div>
  );
}

export function TasksPanel({ model, view, server }: { model: Model; view: View; server: ServerCtx | null }) {
  const { days } = view;
  const mw = model.mw;
  const has = mw.any && days.length > 0;
  const { done, open, overdue } = taskStats(model, view, todayNaive());
  const projName = (id?: string) => (id ? mw.projects.get(id)?.title : undefined);

  return (
    <section className="panel">
      <div className="panel-head"><h2>Tasks</h2>{has && <span className="sub" id="tasksSub">{done.length} completed in range · {open.length} open{overdue.length ? ` · ${overdue.length} overdue` : ""}</span>}</div>
      {server && <MindwtrControls server={server} />}
      <div id="tasks">
        {!has ? (
          <div className="empty">{server ? "Connect Mindwtr's WebDAV folder above, or upload its data.json, to see your tasks here." : "Drop Mindwtr's data.json here to see your tasks."}</div>
        ) : (() => {
          const perDay = days.map(d => done.filter(t => dayStart(t.doneT) === d));
          const peak = Math.max(...perDay.map(a => a.length)), top = Math.max(4, Math.ceil(peak / 2) * 2);
          const counts = STATUS_LABELS.map(([k, label]) => ({ k, label, n: open.filter(t => t.status === k).length }));
          const projects = [...mw.projects.values()].filter(p => p.status === "active").map(p => ({
            p, open: open.filter(t => t.projectId === p.id).length, done: done.filter(t => t.projectId === p.id).length,
          })).sort((a, b) => b.done - a.done || b.open - a.open).slice(0, 10);
          return (
            <>
              <div className="tgroup">
                <div className="panel-head"><span className="eyebrow">Completed per day</span><span className="sub">{(done.length / days.length).toFixed(1)} per day</span></div>
                <ColumnChart className="done" height={110} top={top}
                  grid={[0, top / 2, top].map(v => ({ value: v, label: String(v) }))}
                  columns={perDay.map((a, i) => ({
                    value: a.length,
                    tip: [`${a.length} completed · ${fmtDate(days[i])}`, ...a.slice(0, 6).map(t => "✓ " + t.title), ...(a.length > 6 ? [`and ${a.length - 6} more`] : [])].join("\n"),
                  }))}
                  xLabels={sparseDayLabels(days)} />
              </div>
              <div className="grid2">
                <div className="tgroup">
                  <span className="eyebrow">Open by status</span>
                  <Bars rows={counts.map(c => ({ key: c.k, label: c.label, value: c.n, color: "var(--accent)", valueLabel: c.n, tip: plural(c.n, `${c.label.toLowerCase()} task`) }))} />
                </div>
                <div className="tgroup">
                  <span className="eyebrow">Active projects</span>
                  {projects.length ? (
                    <div className="tablewrap">
                      <table className="data">
                        <thead><tr><th>Project</th><th>Area</th><th>Open</th><th>Done in range</th></tr></thead>
                        <tbody>
                          {projects.map(r => (
                            <tr key={r.p.id}><td>{r.p.title}</td><td>{(r.p.areaId && mw.areas.get(r.p.areaId)?.name) || "–"}</td><td className="num">{r.open}</td><td className="num">{r.done}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <div className="empty">No active projects.</div>}
                </div>
              </div>
              {done.length > 0 && (
                <div className="tgroup">
                  <span className="eyebrow">Recently completed</span>
                  <div className="tlist">
                    {done.slice(0, 8).map(t => (
                      <div key={t.id} className="trow">
                        <time>{fmtDay(dayStart(t.doneT))} {fmtClock(t.doneT)}</time>
                        <span>{t.title}{projName(t.projectId) && <span className="ctx"> · {projName(t.projectId)}</span>}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          );
        })()}
      </div>
    </section>
  );
}
