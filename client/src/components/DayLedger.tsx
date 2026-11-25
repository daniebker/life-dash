import { DAY } from "../../../shared/parsers.ts";
import type { Model, View } from "../lib/model.ts";
import { dayStart, fmtClock, fmtDay, fmtH, fmtHM, isWeekend } from "../lib/format.ts";
import { GROUPS, groupOf, moodColor } from "../lib/groups.ts";
import { Legend } from "./charts.tsx";

const pct = (v: number) => `${(v / DAY) * 100}%`;

/* Each day as a 24-hour strip, coloured by activity group, with mood check-ins as dots. */
export function DayLedger({ model, view }: { model: Model; view: View }) {
  const legend = [
    ...GROUPS.map(g => ({ label: g.name, color: g.color })),
    { label: "Mood +", color: "var(--pos)", round: true },
    { label: "Mood −", color: "var(--neg)", round: true },
  ];
  const empty = !model.log.length && !view.checkins.length;
  return (
    <section className="panel">
      <div className="panel-head"><h2>Day ledger</h2><Legend items={legend} /></div>
      {empty ? <div className="empty">Add a time log (.csv with start, end, activity) to see your days.</div> : (
        <div>
          <div className="hours">
            <span />
            <div className="ax">{[0, 6, 12, 18, 24].map(h => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, "0")}</span>)}</div>
            <span />
          </div>
          <div className="ledger">
            {[...view.days].reverse().map(d => {
              const ps = view.pieces.get(d) ?? [];
              const tracked = ps.filter(p => p.act !== "Other").reduce((a, p) => a + p.ce - p.cs, 0);
              return [
                <span key={d + "d"} className={`d${isWeekend(d) ? " we" : ""}`}>{fmtDay(d)}</span>,
                <div key={d + "s"} className="strip">
                  {ps.map(p => (
                    <i key={p.s + p.act} style={{ left: pct(p.cs - d), width: pct(p.ce - p.cs), background: groupOf(p.act).color }}
                      data-tip={`${p.act}\n${fmtClock(p.s)}–${fmtClock(p.e)} · ${fmtHM(p.e - p.s)}`} />
                  ))}
                  {view.checkins.filter(c => dayStart(c.t) === d).map(c => (
                    <span key={c.t + c.core} className="mood" style={{ left: pct(c.t - d), background: moodColor(c.core) }}
                      data-tip={`${[c.core, c.mid, c.leaf].filter(Boolean).join(" · ")}\n${fmtClock(c.t)}`} />
                  ))}
                </div>,
                <span key={d + "t"} className="t">{tracked ? fmtH(tracked) : "–"}</span>,
              ];
            })}
          </div>
        </div>
      )}
      <div className="note">Each strip is one day from midnight to midnight. Grey is time logged as “Other”; blank is time with no entry. Dots mark mood check-ins. The right column is tracked time excluding “Other”.</div>
    </section>
  );
}
