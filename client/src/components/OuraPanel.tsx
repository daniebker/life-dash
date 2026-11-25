import { useState } from "react";
import { dkey } from "../../../shared/parsers.ts";
import type { Model, View } from "../lib/model.ts";
import * as api from "../lib/api.ts";
import { ago, dayStart, fmtClock, fmtDate, fmtHM } from "../lib/format.ts";
import { ColumnChart, Legend, MetricChart, ScoreChart, sparseDayLabels } from "./charts.tsx";
import { type Note, type ServerCtx, noNote } from "./server.ts";

const SCORES = [
  { key: "sleepScore", name: "Sleep", color: "var(--g-sleep)" },
  { key: "readiness", name: "Readiness", color: "var(--g-work)" },
  { key: "activity", name: "Activity", color: "var(--g-care)" },
] as const;

function OuraControls({ server, initialNote }: { server: ServerCtx; initialNote: Note }) {
  const [note, setNote] = useState<Note>(initialNote);
  const [busy, setBusy] = useState(false);
  const o = server.me.oura;

  async function sync() {
    setBusy(true);
    const r = await api.ouraSync();
    if (r.status === 401) { setBusy(false); return server.signedOut(); }
    if (r.json) { server.updateMe({ oura: r.json.oura }); await server.reload(); }
    setBusy(false);
    if (!r.ok || !r.json) { setNote({ tone: "err", text: r.error ?? "That didn't work." }); return; }
    setNote({ tone: "ok", text: `Synced: ${r.json.added ?? 0} new, ${r.json.updated ?? 0} updated.` });
  }

  async function disconnect() {
    setBusy(true);
    const r = await api.ouraDisconnect();
    setBusy(false);
    if (r.status === 401) return server.signedOut();
    if (!r.ok || !r.json) { setNote({ tone: "err", text: r.error ?? "That didn't work." }); return; }
    server.updateMe({ oura: r.json.oura });
    setNote({ tone: "ok", text: "Oura disconnected. Data already synced is kept." });
  }

  const connect = (label: string) => <a className="ghost primary" href="/api/oura/connect" style={{ textDecoration: "none" }}>{label}</a>;
  let state, buttons = null;
  if (!o.configured) state = <><span className="dot" />Oura sign-in isn't set up on the server (OURA_CLIENT_ID and OURA_CLIENT_SECRET).</>;
  else if (!o.connected) { state = <><span className="dot" />Not connected</>; buttons = connect("Connect Oura"); }
  else if (o.status === "needs_reauth") {
    state = <><span className="dot warn" />{o.lastError || "Oura needs to be connected again."}</>;
    buttons = <>{connect("Reconnect Oura")}<button type="button" className="ghost" data-oura="disconnect" disabled={busy} onClick={disconnect}>Disconnect</button></>;
  } else {
    const next = o.nextSyncAt ? ` · next sync ${new Date(o.nextSyncAt * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : "";
    state = o.syncing ? <><span className="dot on" />Syncing…</>
      : <><span className={`dot ${o.lastError ? "warn" : "on"}`} />Connected · {o.lastSyncAt ? "synced " + ago(o.lastSyncAt) : "first sync pending"}{o.lastError ? ` · ${o.lastError}` : ""}{next}</>;
    buttons = <>
      <button type="button" className="ghost" data-oura="sync" disabled={busy || o.syncing} onClick={sync}>Sync now</button>
      <button type="button" className="ghost" data-oura="disconnect" disabled={busy} onClick={disconnect}>Disconnect</button>
    </>;
  }
  return (
    <div className="octl" id="ouraCtl">
      {buttons}<span className="state">{state}</span>
      <span className={`msg${note.tone ? " " + note.tone : ""}`} id="ouraMsg">{note.text}</span>
    </div>
  );
}

export function OuraPanel({ model, view, server, initialNote = noNote }: { model: Model; view: View; server: ServerCtx | null; initialNote?: Note }) {
  const { days } = view;
  const ks = days.map(dkey), rows = ks.map(k => model.oura.days[k] ?? { day: k });
  const scored = rows.filter(r => SCORES.some(s => r[s.key] != null)).length;
  const nightly = ks.map(k => model.oura.sleep.get(k));
  const steps = rows.map(r => r.steps), haveSteps = steps.filter((v): v is number => v != null);
  const nights = ks.map((k, i) => ({
    k, d: days[i], o: model.oura.sleep.get(k),
    logged: model.log.filter(r => r.act === "Sleep" && dayStart(r.e) === days[i]).reduce((a, r) => a + r.e - r.s, 0),
  })).filter(n => n.o).reverse();
  const cell = <T,>(v: T | undefined | null, f: (v: T) => string) => (v != null && !(typeof v === "number" && Number.isNaN(v)) ? f(v) : "–");

  return (
    <section className="panel">
      <div className="panel-head"><h2>Oura</h2>{model.oura.any && <span className="sub" id="ouraSub">{scored} of {ks.length} days with scores</span>}</div>
      {server && <OuraControls server={server} initialNote={initialNote} />}
      <div id="oura">
        {!model.oura.any ? (
          <div className="empty">
            {server
              ? (server.me.oura.connected ? "Waiting for the first sync from Oura." : <>Connect Oura to sync your sleep, readiness and activity automatically, or drop an <code>oura.json</code> export above.</>)
              : <>No Oura data yet. Run <code>scripts/oura-sync.ts</code> with your Oura token, or drop an <code>oura.json</code> here.</>}
          </div>
        ) : (
          <>
            <Legend items={SCORES.map(s => ({ label: `${s.name} score`, color: s.color }))} />
            <ScoreChart days={days} label="Oura sleep, readiness and activity scores per day"
              series={SCORES.map(s => ({ key: s.key, name: s.name, color: s.color, values: rows.map(r => r[s.key]) }))} />

            {/* HRV and lowest heart rate have different units: two charts side by side, never one chart with two axes */}
            {nightly.some(n => n?.hrv != null || n?.low != null) && (
              <div className="grid2">
                <MetricChart days={days} values={nightly.map(n => n?.hrv)} name="Average HRV" unit="ms" color="var(--g-care)" />
                <MetricChart days={days} values={nightly.map(n => n?.low)} name="Lowest heart rate" unit="bpm" color="var(--g-work)" />
              </div>
            )}

            {haveSteps.length > 0 && (() => {
              const top = Math.ceil(Math.max(10000, ...haveSteps) / 5000) * 5000;
              const avg = Math.round(haveSteps.reduce((a, b) => a + b, 0) / haveSteps.length);
              return (
                <div className="tgroup">
                  <div className="panel-head"><span className="eyebrow">Steps</span><span className="sub">{avg.toLocaleString("en-GB")} per day · dashed line is 10k</span></div>
                  <ColumnChart className="steps" height={110} top={top}
                    grid={[0, 5000, 10000].map(v => ({ value: v, label: `${v / 1000}k`, target: v === 10000 }))}
                    columns={rows.map((r, i) => ({
                      value: r.steps || 0,
                      tip: `${r.steps != null ? r.steps.toLocaleString("en-GB") + " steps" : "No data"} · ${fmtDate(days[i])}${r.kcal != null ? `\n${r.kcal} active kcal` : ""}`,
                    }))}
                    xLabels={sparseDayLabels(days, 10)} />
                </div>
              );
            })()}

            {nights.length > 0 && (
              <>
                <div className="tablewrap">
                  <table className="data">
                    <thead><tr><th>Night into</th><th>Bed → wake</th><th>Asleep</th><th>In bed</th><th>Logged</th><th>Efficiency</th><th>Deep</th><th>REM</th><th>Avg HRV</th><th>Lowest HR</th><th>Temp</th></tr></thead>
                    <tbody>
                      {nights.map(n => {
                        const o = n.o!, t = model.oura.days[n.k]?.temp;
                        return (
                          <tr key={n.k}>
                            <td>{fmtDate(n.d)}</td>
                            <td className="num">{Number.isNaN(o.start) ? "–" : `${fmtClock(o.start)} → ${fmtClock(o.end)}`}</td>
                            <td className="num">{cell(o.asleep, fmtHM)}</td>
                            <td className="num">{cell(o.inBed, fmtHM)}</td>
                            <td className="num">{n.logged ? fmtHM(n.logged) : "–"}</td>
                            <td className="num">{cell(o.eff, v => v + "%")}</td>
                            <td className="num">{cell(o.deep, fmtHM)}</td>
                            <td className="num">{cell(o.rem, fmtHM)}</td>
                            <td className="num">{cell(o.hrv, v => Math.round(v) + " ms")}</td>
                            <td className="num">{cell(o.low, v => v + " bpm")}</td>
                            <td className="num">{cell(t, v => (v > 0 ? "+" : "") + v.toFixed(1) + "°")}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="note">“Logged” is the Sleep entry in your time log ending that morning, for comparison with what the ring measured.</div>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

