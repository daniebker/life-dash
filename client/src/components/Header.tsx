import type { Range } from "../lib/model.ts";
import { fmtDate, plural } from "../lib/format.ts";

const RANGES: { value: Range; label: string }[] = [{ value: 7, label: "7 days" }, { value: 14, label: "14 days" }, { value: 30, label: "30 days" }, { value: 0, label: "All" }];

export function Header({ days, range, onRange, username, onSignOut }: {
  days: number[]; range: Range; onRange: (r: Range) => void; username?: string; onSignOut?: () => void;
}) {
  const span = days.length ? `${fmtDate(days[0])} – ${fmtDate(days[days.length - 1])} · ${plural(days.length, "day")}` : "No data loaded";
  return (
    <header className="top">
      <div>
        <div className="eyebrow" id="spanLabel">{span}</div>
        <h1>Life Dash</h1>
      </div>
      <div className="head-right">
        {username && (
          <div className="account" id="account">
            <span id="whoami">{username}</span>
            <button type="button" className="ghost" id="logout" onClick={onSignOut}>Sign out</button>
          </div>
        )}
        <div className="seg" role="group" aria-label="Date range" id="range">
          {RANGES.map(r => (
            <button key={r.value} type="button" aria-pressed={range === r.value} onClick={() => onRange(r.value)}>{r.label}</button>
          ))}
        </div>
      </div>
    </header>
  );
}
