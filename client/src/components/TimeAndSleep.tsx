import { DAY } from "../../../shared/parsers.ts";
import type { Model, View } from "../lib/model.ts";
import { dayOfMonth, dayStart, fmtClock, fmtDate, fmtH, fmtHM, minutesToClock } from "../lib/format.ts";
import { groupOf } from "../lib/groups.ts";
import { Bars, ColumnChart, Swatch } from "./charts.tsx";

export function TimePanel({ model, view }: { model: Model; view: View }) {
  const entries = Object.entries(view.byAct).sort((a, b) => b[1] - a[1]);
  const n = view.days.length || 1;
  const unused = model.acts.filter(a => !view.byAct[a]);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Where the time went</h2>{entries.length > 0 && <span className="sub">total · per day</span>}</div>
      {!entries.length ? <div className="empty">No time log in this range.</div> : (
        <>
          <Bars rows={entries.map(([a, s]) => {
            const g = groupOf(a);
            return {
              key: a, value: s, color: g.color,
              label: <><Swatch color={g.color} />{a}</>,
              valueLabel: `${fmtH(s)} · ${fmtHM(s / n)}`,
              tip: `${a} (${g.name})\n${fmtHM(s)} total · ${fmtHM(s / n)} per day`,
            };
          })} />
          {unused.length > 0 && <div className="note">Not logged in this range: {unused.join(", ")}</div>}
        </>
      )}
    </section>
  );
}

export function SleepPanel({ view }: { view: View }) {
  const sleeps = view.sleeps;
  if (!sleeps.length) {
    return <section className="panel"><div className="panel-head"><h2>Sleep per night</h2></div><div className="empty">No “Sleep” entries in this range.</div></section>;
  }
  const maxH = Math.max(10, Math.ceil(Math.max(...sleeps.map(r => (r.e - r.s) / 3600))));
  const bed = sleeps.map(r => { let m = (r.s % DAY) / 60; if (m < 12 * 60) m += 1440; return m; });
  const avgBed = (bed.reduce((a, b) => a + b, 0) / bed.length) % 1440;
  const avgWake = sleeps.reduce((a, r) => a + (r.e % DAY) / 60, 0) / sleeps.length;
  const step = Math.ceil(sleeps.length / 14);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Sleep per night</h2><span className="sub">avg bed {minutesToClock(avgBed)} · wake {minutesToClock(avgWake)}</span></div>
      <ColumnChart
        top={maxH}
        grid={[0, 4, 8].filter(h => h <= maxH).map(h => ({ value: h, label: `${h}h`, target: h === 8 }))}
        columns={sleeps.map(r => ({ value: (r.e - r.s) / 3600, tip: `${fmtHM(r.e - r.s)} · night into ${fmtDate(dayStart(r.e))}\n${fmtClock(r.s)} → ${fmtClock(r.e)}` }))}
        xLabels={sleeps.map((r, i) => (i % step === 0 ? String(dayOfMonth(r.e)) : ""))}
      />
      <div className="note">Dashed line is 8 hours. Bars are labelled by the morning you woke up.</div>
    </section>
  );
}
