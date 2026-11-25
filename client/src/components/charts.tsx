/* Chart building blocks. Colours always come from CSS custom properties, so both themes work. */
import type { ReactNode } from "react";
import { dayOfMonth, fmtDate } from "../lib/format.ts";
import { useWidth } from "../lib/hooks.ts";

/* ---------- vertical columns (sleep, steps, tasks completed) ---------- */
export interface Column { value: number; tip: string }
export interface GridLine { value: number; label: string; target?: boolean }

export function ColumnChart({ columns, top, grid, xLabels, className = "", height }: {
  columns: Column[]; top: number; grid: GridLine[]; xLabels: string[]; className?: string; height?: number;
}) {
  return (
    <div>
      <div className={`cols ${className}`} style={height ? { height } : undefined}>
        {grid.map(g => (
          <div key={g.value} className={`gl${g.target ? " target" : ""}`} style={{ bottom: `${(g.value / top) * 100}%` }}><span>{g.label}</span></div>
        ))}
        {columns.map((c, i) => <div key={i} className="c" style={{ height: `${(c.value / top) * 100}%` }} data-tip={c.tip} />)}
      </div>
      <div className="xlabels">{xLabels.map((l, i) => <span key={i}>{l}</span>)}</div>
    </div>
  );
}

// Every n-th day of the month as an x label, so labels don't crowd.
export const sparseDayLabels = (days: number[], max = 14): string[] => {
  const step = Math.ceil(days.length / max);
  return days.map((d, i) => (i % step === 0 ? String(dayOfMonth(d)) : ""));
};

/* ---------- horizontal bars (time per activity, mood, task status) ---------- */
export interface BarRow { key: string; label: ReactNode; value: number; color: string; valueLabel: ReactNode; tip?: string }

export function Bars({ rows, max }: { rows: BarRow[]; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map(r => r.value));
  return (
    <div className="bars">
      {rows.map(r => [
        <span key={r.key + ":l"} className="lab">{r.label}</span>,
        <div key={r.key + ":t"} className="track" data-tip={r.tip}>
          <div className="fill" style={{ width: `${(r.value / top) * 100}%`, background: r.color }} />
        </div>,
        <span key={r.key + ":v"} className="val">{r.valueLabel}</span>,
      ])}
    </div>
  );
}

export const Swatch = ({ color, round = false }: { color: string; round?: boolean }) =>
  <i className="sw" style={{ background: color, borderRadius: round ? "50%" : undefined }} />;

export function Legend({ items }: { items: { label: string; color?: string; round?: boolean }[] }) {
  return (
    <div className="legend">
      {items.map(it => <span key={it.label}>{it.color && <Swatch color={it.color} round={it.round} />}{it.label}</span>)}
    </div>
  );
}

/* ---------- line charts ---------- */
type Point = number | null | undefined;

// Path through the points, broken where values are missing.
function linePath(values: Point[], x: (i: number) => number, y: (v: number) => number): string {
  let d = "", pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
  });
  return d;
}
const lastPoint = (values: Point[]) => { for (let i = values.length - 1; i >= 0; i--) { const v = values[i]; if (v != null) return { i, v }; } return null; };

export interface Series { key: string; name: string; color: string; values: Point[] }

/* Several series on one 0–100 scale (Oura scores), labelled at their right-hand ends. */
export function ScoreChart({ days, series, label }: { days: number[]; series: Series[]; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(280, width), H = 170, L = 26, R = 92, T = 8, B = 20;
  const all = series.flatMap(s => s.values).filter((v): v is number => v != null);
  const lo = all.length ? Math.min(50, Math.floor((Math.min(...all) - 5) / 10) * 10) : 50;
  const x = (i: number) => L + (days.length > 1 ? i / (days.length - 1) : 0.5) * (W - L - R);
  const y = (v: number) => T + ((100 - v) / (100 - lo)) * (H - T - B);
  const step = Math.ceil(days.length / 10);
  const grid: number[] = []; for (let g = lo; g <= 100; g += 10) grid.push(g);

  const ends = series.map(s => ({ s, last: lastPoint(s.values) })).filter(e => e.last)
    .map(e => ({ ...e, ly: y(e.last!.v) })).sort((a, b) => a.ly - b.ly);
  ends.forEach((e, i) => { if (i && e.ly - ends[i - 1].ly < 13) e.ly = ends[i - 1].ly + 13; });
  const cw = (W - L - R) / Math.max(1, days.length - 1);

  return (
    <div className="ochart" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} height={H} role="img" aria-label={label}>
        {grid.map(g => <g key={g}><line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke="var(--line)" /><text x={L - 6} y={y(g) + 3} textAnchor="end">{g}</text></g>)}
        {days.map((d, i) => (i % step === 0 || i === days.length - 1) && <text key={d} x={x(i)} y={H - 4} textAnchor="middle">{dayOfMonth(d)}</text>)}
        {series.map(s => (
          <g key={s.key}>
            <path d={linePath(s.values, x, y)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {s.values.map((v, i) => v != null && s.values[i - 1] == null && s.values[i + 1] == null && <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={s.color} />)}
          </g>
        ))}
        {ends.map(e => <circle key={e.s.key} cx={x(e.last!.i)} cy={y(e.last!.v)} r={4} fill={e.s.color} stroke="var(--panel)" strokeWidth={2} />)}
        {ends.map(e => <text key={e.s.key + "l"} className="dl" x={W - R + 10} y={e.ly + 4}>{e.s.name} {e.last!.v}</text>)}
        {days.map((d, i) => (
          <rect key={d} className="hit" x={x(i) - cw / 2} y={T} width={cw} height={H - T - B}
            data-tip={[fmtDate(d), ...series.map(s => `${s.name}: ${s.values[i] ?? "–"}`)].join("\n")} />
        ))}
      </svg>
    </div>
  );
}

/* One nightly metric with its own scale, the period average as a dashed line, and the latest value labelled. */
export function MetricChart({ days, values, name, unit, color, digits = 0 }: {
  days: number[]; values: Point[]; name: string; unit: string; color: string; digits?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const have = values.filter((v): v is number => v != null);
  if (!have.length) return null;
  const W = Math.max(260, width), H = 140, L = 30, R = 58, T = 8, B = 20;
  const mn = Math.min(...have), mx = Math.max(...have);
  const stepV = [1, 2, 5, 10, 20, 50].find(st => (mx - mn) / st <= 4) ?? 100;
  const lo = Math.floor((mn - stepV * 0.5) / stepV) * stepV, hi = Math.ceil((mx + stepV * 0.5) / stepV) * stepV;
  const x = (i: number) => L + (days.length > 1 ? i / (days.length - 1) : 0.5) * (W - L - R);
  const y = (v: number) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const grid: number[] = []; for (let g = lo; g <= hi + 1e-9; g += stepV) grid.push(g);
  const xstep = Math.ceil(days.length / (W < 420 ? 5 : 8));
  const avg = have.reduce((a, b) => a + b, 0) / have.length;
  const last = lastPoint(values)!;
  const cw = (W - L - R) / Math.max(1, days.length - 1);
  const fmt = (v: number) => `${v.toFixed(digits)} ${unit}`;

  return (
    <div className="tgroup">
      <div className="panel-head"><span className="eyebrow">{name}</span><span className="sub">avg {fmt(avg)} · dashed line</span></div>
      <div className="ochart" ref={ref}>
        <svg viewBox={`0 0 ${W} ${H}`} height={H} role="img" aria-label={`${name} per night, average ${fmt(avg)}`}>
          {grid.map(g => <g key={g}><line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke="var(--line)" /><text x={L - 6} y={y(g) + 3} textAnchor="end">{g}</text></g>)}
          {days.map((d, i) => i % xstep === 0 && <text key={d} x={x(i)} y={H - 4} textAnchor="middle">{dayOfMonth(d)}</text>)}
          <line x1={L} x2={W - R} y1={y(avg)} y2={y(avg)} stroke="var(--ink-3)" strokeDasharray="3 3" />
          <path d={linePath(values, x, y)} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {values.map((v, i) => v != null && values[i - 1] == null && values[i + 1] == null && <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={color} />)}
          <circle cx={x(last.i)} cy={y(last.v)} r={4} fill={color} stroke="var(--panel)" strokeWidth={2} />
          <text className="dl" x={W - R + 10} y={y(last.v) + 4}>{fmt(last.v)}</text>
          {days.map((d, i) => {
            const v = values[i];
            return <rect key={d} className="hit" x={x(i) - cw / 2} y={T} width={cw} height={H - T - B}
              data-tip={`${v != null ? fmt(v) : "No data"} · ${name}\nNight into ${fmtDate(d)}`} />;
          })}
        </svg>
      </div>
    </div>
  );
}
