import { useLayoutEffect, useRef } from "react";
import { dkey } from "../../../shared/parsers.ts";
import type { Model, View } from "../lib/model.ts";
import { dayOfMonth, fmtDate } from "../lib/format.ts";

const shade = (f: number) => f <= 0 ? "var(--empty)" : f < 0.34 ? "var(--s2)" : f < 0.67 ? "var(--s3)" : f < 1 ? "var(--s4)" : "var(--s5)";

export function HabitsPanel({ model, view }: { model: Model; view: View }) {
  const wrap = useRef<HTMLDivElement>(null);
  const { days } = view;
  const ks = days.map(dkey);
  // show the most recent days first on narrow screens
  useLayoutEffect(() => { const w = wrap.current; if (w) w.scrollLeft = w.scrollWidth; }, [days.length, model.habits.length]);

  return (
    <section className="panel">
      <div className="panel-head"><h2>Habits</h2>{model.habits.length > 0 && <span className="sub">darker = closer to the daily target; outlined = target met</span>}</div>
      {!model.habits.length ? <div className="empty">Add a habits file (.dat) to see streaks.</div> : (
        <>
          <div className="hm-wrap" ref={wrap}>
            <table className="hm">
              <thead><tr><th />{days.map(d => <th key={d}>{dayOfMonth(d)}</th>)}<th /></tr></thead>
              <tbody>
                {model.habits.map(h => {
                  // current streak, ending at the last day (today may not be logged yet, so it's skipped if empty)
                  let streak = 0;
                  for (let i = ks.length - 1; i >= 0; i--) {
                    if ((h.days[ks[i]] || 0) >= h.target) streak++;
                    else if (i === ks.length - 1) continue;
                    else break;
                  }
                  const active = ks.filter(k => h.days[k]).length;
                  const met = ks.filter(k => (h.days[k] || 0) >= h.target).length;
                  return (
                    <tr key={h.name}>
                      <th>{h.name} <span className="note">×{h.target}</span></th>
                      {ks.map((k, i) => {
                        const v = h.days[k] || 0, f = v / h.target;
                        return <td key={k} className={`cell${f >= 1 ? " hit" : ""}`} style={{ background: shade(f) }}
                          data-tip={`${h.name} · ${fmtDate(days[i])}\n${v} / ${h.target}${f >= 1 ? " ✓" : ""}`} />;
                      })}
                      <td className="stat">{active ? `${met}/${ks.length} met · streak ${streak}` : "no entries"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="legend">
            <span>0</span>
            {["--s2", "--s3", "--s4", "--s5"].map(v => <span key={v}><i className="sw" style={{ background: `var(${v})` }} /></span>)}
            <span>target</span>
          </div>
        </>
      )}
    </section>
  );
}
