import { dkey } from "../../../shared/parsers.ts";
import { type Model, type View, habitStats, taskStats } from "../lib/model.ts";
import { fmtH, fmtHM, plural, todayNaive } from "../lib/format.ts";
import { moodValue } from "../lib/groups.ts";

interface Tile { key: string; value: string | number; unit: string; note: string }

export function Kpis({ model, view }: { model: Model; view: View }) {
  const { days, byAct, perDayAct, sleeps, checkins } = view;
  const tiles: Tile[] = [];

  if (sleeps.length) {
    const avg = sleeps.reduce((a, r) => a + r.e - r.s, 0) / sleeps.length;
    const short = sleeps.filter(r => r.e - r.s < 7 * 3600).length;
    tiles.push({ key: "Sleep", value: fmtHM(avg), unit: "avg per night", note: `${short} of ${sleeps.length} nights under 7h` });
  }
  const workDays = days.filter(d => (perDayAct.get(d)?.Work || 0) > 0);
  if (workDays.length) {
    const tot = workDays.reduce((a, d) => a + (perDayAct.get(d)?.Work || 0), 0);
    tiles.push({ key: "Work", value: fmtHM(tot / workDays.length), unit: "per working day", note: `${fmtH(tot)} over ${workDays.length} days` });
  }
  const total = Object.values(byAct).reduce((a, b) => a + b, 0);
  if (total) {
    const awake = total - (byAct.Sleep || 0), other = byAct.Other || 0;
    tiles.push({ key: "Tracked", value: Math.round((100 * (awake - other)) / awake) + "%", unit: "of waking time", note: `${fmtH(other)} logged as Other` });
  }
  const readiness = days.map(d => model.oura.days[dkey(d)]?.readiness).filter((v): v is number => v != null);
  if (readiness.length) {
    const asleep = days.map(d => model.oura.sleep.get(dkey(d))?.asleep).filter((v): v is number => v != null);
    tiles.push({
      key: "Readiness", value: Math.round(readiness.reduce((a, b) => a + b, 0) / readiness.length), unit: "avg Oura score",
      note: asleep.length ? `${fmtHM(asleep.reduce((a, b) => a + b, 0) / asleep.length)} actual sleep per night` : `${readiness.length} days`,
    });
  }
  if (model.mw.any && days.length) {
    const { done, overdue } = taskStats(model, view, todayNaive());
    const next = model.mw.tasks.filter(t => t.status === "next").length;
    tiles.push({ key: "Tasks", value: done.length, unit: "completed", note: `${plural(next, "next action")}${overdue.length ? ` · ${overdue.length} overdue` : ""}` });
  }
  const hs = habitStats(model, days);
  if (hs.possible) tiles.push({ key: "Habits", value: Math.round((100 * hs.hit) / hs.possible) + "%", unit: "targets met", note: `${hs.hit} of ${hs.possible} habit-days` });
  if (checkins.length) {
    const pos = checkins.filter(c => moodValue(c.core) > 0).length;
    tiles.push({ key: "Mood", value: Math.round((100 * pos) / checkins.length) + "%", unit: "positive", note: plural(checkins.length, "check-in") });
  }

  return (
    <section className="kpis" id="kpis">
      {tiles.length ? tiles.map(t => (
        <div key={t.key} className="kpi">
          <span className="eyebrow">{t.key}</span>
          <span className="v">{t.value}<small> {t.unit}</small></span>
          <span className="n">{t.note}</span>
        </div>
      )) : (
        <div className="kpi"><span className="eyebrow">Getting started</span><span className="n">Add your exported files above to see your numbers.</span></div>
      )}
    </section>
  );
}
