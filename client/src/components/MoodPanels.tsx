import { type Model, type View, activityAt } from "../lib/model.ts";
import { dayStart, fmtClock, fmtDay } from "../lib/format.ts";
import { groupOf, moodColor, moodValue } from "../lib/groups.ts";
import { Bars, Legend, Swatch } from "./charts.tsx";

export function MoodPanels({ model, view }: { model: Model; view: View }) {
  const chk = view.checkins;
  if (!chk.length) {
    return (
      <div className="grid2">
        <section className="panel"><div className="panel-head"><h2>Mood check-ins</h2></div><div className="empty">Add a check-ins file (time, feeling, sub-feeling…) to track mood.</div></section>
        <section className="panel"><div className="panel-head"><h2>Mood by activity</h2><span className="sub">what you were doing when you checked in</span></div><div className="empty">No check-ins to compare yet.</div></section>
      </div>
    );
  }
  const byCore = new Map<string, number>();
  for (const c of chk) byCore.set(c.core, (byCore.get(c.core) || 0) + 1);
  const cores = [...byCore.entries()].sort((a, b) => b[1] - a[1]);

  const agg = new Map<string, { n: number; pos: number; neg: number }>();
  for (const c of chk) {
    const a = activityAt(model, c.t), s = agg.get(a) ?? { n: 0, pos: 0, neg: 0 };
    s.n++; const v = moodValue(c.core); if (v > 0) s.pos++; else if (v < 0) s.neg++;
    agg.set(a, s);
  }
  const acts = [...agg.entries()].sort((a, b) => b[1].n - a[1].n);
  const maxN = Math.max(...acts.map(r => r[1].n));

  return (
    <div className="grid2">
      <section className="panel">
        <div className="panel-head"><h2>Mood check-ins</h2><span className="sub">{chk.length} in range</span></div>
        <Bars rows={cores.map(([k, n]) => ({ key: k, value: n, color: moodColor(k), label: <><Swatch color={moodColor(k)} round />{k}</>, valueLabel: n }))} />
        <div className="moodlist">
          {[...chk].reverse().slice(0, 12).map(c => (
            <div key={c.t + c.core} className="mrow">
              <time>{fmtDay(dayStart(c.t))} {fmtClock(c.t)}</time>
              <span>
                <span className="tag"><i className="sw" style={{ background: moodColor(c.core) }} />{c.core}</span>
                {" · "}{[c.mid, c.leaf].filter(Boolean).join(" · ")} <span className="ctx">— during {activityAt(model, c.t)}</span>
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><h2>Mood by activity</h2><span className="sub">what you were doing when you checked in</span></div>
        <div className="bars">
          {acts.map(([a, s]) => {
            const neu = s.n - s.pos - s.neg;
            return [
              <span key={a + "l"} className="lab"><Swatch color={groupOf(a).color} />{a}</span>,
              <div key={a + "t"} className="track" style={{ display: "flex", gap: 2, width: `${(s.n / maxN) * 100}%` }}
                data-tip={`${a}\n${s.pos} positive · ${neu} neutral · ${s.neg} negative`}>
                {s.pos > 0 && <div className="fill" style={{ flex: s.pos, background: "var(--pos)", borderRadius: 0 }} />}
                {neu > 0 && <div className="fill" style={{ flex: neu, background: "var(--neu)", borderRadius: 0 }} />}
                {s.neg > 0 && <div className="fill" style={{ flex: s.neg, background: "var(--neg)", borderRadius: "0 4px 4px 0" }} />}
              </div>,
              <span key={a + "v"} className="val">{s.pos}+ {s.neg}−</span>,
            ];
          })}
        </div>
        <Legend items={[{ label: "Positive", color: "var(--pos)" }, { label: "Neutral", color: "var(--neu)" }, { label: "Negative", color: "var(--neg)" }]} />
        <div className="note">Each check-in is matched to the time-log entry running at that moment.</div>
      </section>
    </div>
  );
}
