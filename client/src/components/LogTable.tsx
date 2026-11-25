import type { Model, View } from "../lib/model.ts";
import { fmtClock, fmtDate, fmtHM } from "../lib/format.ts";
import { groupOf } from "../lib/groups.ts";

export function LogTable({ model, view }: { model: Model; view: View }) {
  const rows = model.log.filter(r => r.e > view.lo && r.s < view.hi);
  return (
    <section className="panel">
      <details>
        <summary>Time log table</summary>
        <div className="tablewrap" id="logTable" style={{ marginTop: 10 }}>
          {!rows.length ? <div className="empty">No entries.</div> : (
            <table className="data">
              <thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Activity</th><th>Group</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.s + r.act}>
                    <td className="num">{fmtDate(r.s)} {fmtClock(r.s)}</td>
                    <td className="num">{fmtClock(r.e)}</td>
                    <td className="num">{fmtHM(r.e - r.s)}</td>
                    <td>{r.act}</td>
                    <td>{groupOf(r.act).name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </details>
    </section>
  );
}
