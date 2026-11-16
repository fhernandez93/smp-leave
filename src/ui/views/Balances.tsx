import { totalDays } from "../../domain/counting";
import { DOW, fmtDate, fmtHours, mondayIndex, num, parseISO, plural } from "../../domain/dates";
import { PUBLISHED_YEARS } from "../../domain/calendar";
import { balance, overtimeBalance, overtimeInYear, type LeaveRecord } from "../../domain/model";
import { csvFilename, toCSV } from "../../domain/csv";
import { archiveCarries, recordsForYear, toast } from "../../state/actions";
import { derive, nameOf, store, useApp } from "../../state/store";
import { Empty, OvertimeButton, TYPES, YearPicker } from "../common";
import type { Model } from "../../domain/model";

/** For an archived year, balances are computed from the archived records. */
function modelForYear(year: number, live: Model): Model {
  const recs = recordsForYear(year);
  if (recs === live.records) return live;
  return { ...live, records: recs, leave: recs.filter((r): r is LeaveRecord => r.kind === "leave"), overtime: recs.filter((r) => r.kind === "overtime") as Model["overtime"] };
}

export function Balances() {
  const [s, d] = useApp();
  const { cal } = d;
  const y = s.year;
  const model = modelForYear(y, d.model);
  const carries = archiveCarries();
  const anyOvertime = model.overtime.length > 0 || model.leave.some((r) => r.type === "comp") || carries.length > 0;
  const hol = [...cal.holidaysFor(y).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const gained = hol.reduce((a, [ds, x]) => a + (cal.isWorkday(parseISO(ds)) ? x.fraction : 0), 0);

  return (
    <>
      <div className="panel">
        <div className="hd">
          <h2>Vacation balances</h2>
          <span className="spacer" />
          <YearPicker />
          {s.downloads && <button className="btn sm" type="button" onClick={() => void exportCSV()}>Export CSV</button>}
        </div>
        <div className="scroll-x">
          <table data-testid="balances">
            <thead>
              <tr>
                <th>Person</th><th className="r">Entitlement</th><th className="r">Carried over</th><th className="r">Taken</th>
                <th className="r">Pending</th><th className="r">Left</th><th className="r">Sick</th><th className="r">Remote</th>
              </tr>
            </thead>
            <tbody>
              {d.activeMembers.map((m) => {
                const b = balance(cal, model, m, y);
                const cap = Math.max(b.ent + b.carry, 0.001);
                return (
                  <tr key={m.id}>
                    <td>
                      <div>{nameOf(s, d, m.id)}{m.id === d.memberId && <span className="dim"> (you)</span>}</div>
                      <div className="bar">
                        <i className="used" style={{ width: `${Math.min(100, (b.taken / cap) * 100)}%` }} />
                        <i className="pend" style={{ width: `${Math.min(100, (b.pending / cap) * 100)}%` }} />
                      </div>
                    </td>
                    <td className="r num">{num(b.ent)}</td>
                    <td className="r num">{b.carry ? num(b.carry) : "—"}</td>
                    <td className="r num">{num(b.taken)}</td>
                    <td className="r num">{b.pending ? num(b.pending) : "—"}</td>
                    <td className="r num" style={{ fontWeight: 600, color: b.left < 0 ? "var(--danger)" : undefined }}>{num(b.left)}</td>
                    <td className="r num dim">{b.sick ? num(b.sick) : "—"}</td>
                    <td className="r num dim">{b.remote ? num(b.remote) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="hd">
          <h2>Overtime</h2>
          <span className="spacer" />
          <span className="tiny dim">A full day is {num(cal.hoursPerDay())} h</span>
          <OvertimeButton />
        </div>
        {!anyOvertime ? (
          <Empty title="No overtime logged yet">Hours only count once an approver approves them. They bank up and can be taken back as time off in lieu.</Empty>
        ) : (
          <>
            <div className="scroll-x">
              <table data-testid="overtime">
                <thead>
                  <tr><th>Person</th><th className="r">Approved in {y}</th><th className="r">Pending</th><th className="r">Taken in lieu</th><th className="r">Bank</th><th className="r">Days in lieu</th></tr>
                </thead>
                <tbody>
                  {d.activeMembers.map((m) => {
                    const yy = overtimeInYear(cal, model, m.id, y);
                    const all = overtimeBalance(cal, d.model, m.id, carries);
                    return (
                      <tr key={m.id}>
                        <td>{nameOf(s, d, m.id)}{m.id === d.memberId && <span className="dim"> (you)</span>}</td>
                        <td className="r num">{yy.approved ? fmtHours(yy.approved) : "—"}</td>
                        <td className="r num">{yy.pending ? fmtHours(yy.pending) : "—"}</td>
                        <td className="r num">{yy.spent ? fmtHours(-yy.spent) : "—"}</td>
                        <td className="r num" style={{ fontWeight: 600, color: all.left < 0 ? "var(--danger)" : undefined }}>{fmtHours(all.left)}</td>
                        <td className="r num dim">{all.left ? num(Math.round((all.left / cal.hoursPerDay()) * 10) / 10) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pad tiny dim">The bank is cumulative and does not reset in January. Taking time off in lieu draws it down at {num(cal.hoursPerDay())} h a day.</div>
          </>
        )}
      </div>

      <div className="panel">
        <div className="hd">
          <h2>Days off in {y}</h2>
          <span className="spacer" />
          <span className="tiny dim">{plural(gained, "working day", "working days")} free — these never count against leave</span>
        </div>
        <div className="scroll-x">
          <table data-testid="daysoff">
            <thead><tr><th>Date</th><th></th><th>Day off</th><th>Kind</th><th className="r">Free</th></tr></thead>
            <tbody>
              {hol.map(([ds, x]) => {
                const weekend = !cal.isWorkday(parseISO(ds));
                return (
                  <tr key={ds} style={weekend ? { opacity: 0.5 } : undefined}>
                    <td className="num" style={{ width: 118 }}>{fmtDate(ds)}</td>
                    <td className="num dim" style={{ width: 52 }}>{DOW[mondayIndex(parseISO(ds))]}</td>
                    <td>{x.name}{x.de && <span className="tiny dim" style={{ display: "block" }}>{x.de}</span>}</td>
                    <td className="tiny dim">{x.kind === "legal" ? "Gesetzlicher Feiertag" : x.kind === "service" ? "Dienstfreier Tag" : "Added by the team"}</td>
                    <td className="r num">{weekend ? "—" : x.fraction < 1 ? "½ day" : "1 day"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="pad tiny dim">
          {PUBLISHED_YEARS.includes(y)
            ? `Matches the calendar published for State of Fribourg employees for ${y}.`
            : `The State publishes 24 and 31 December separately each year. For ${y} they are an estimate until you set them in Settings.`}
        </div>
      </div>
    </>
  );
}

/** CSV export, same layout as v1. */
export async function exportCSV(): Promise<void> {
  const s = store.get();
  const d = derive(s);
  if (!s.downloads) return;
  const y = s.year;
  const model = modelForYear(y, d.model);
  const { cal } = d;
  const name = (id: string | null) => (id ? nameOf(s, d, id) : "");
  const rows: unknown[][] = [["Person", "Type", "Start", "End", "Days", "Status", "Note", "Decided by", "Requested"]];
  for (const r of [...model.leave].sort((a, b) => a.start.localeCompare(b.start))) {
    rows.push([name(r.memberId), TYPES[r.type].label, r.start, r.end, num(totalDays(cal, r)), r.status, r.note, r.decision && !r.auto ? name(r.decision.by) : "", (r.createdAt ?? "").slice(0, 10)]);
  }
  rows.push([]);
  rows.push(["Overtime", "Person", "Date", "Hours", "Status", "Reason", "Decided by"]);
  for (const o of [...model.overtime].sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push(["", name(o.memberId), o.date, o.hours, o.status, o.note, o.decision ? name(o.decision.by) : ""]);
  }
  rows.push([]);
  rows.push(["Overtime bank", "Person", `Approved ${y}`, "Pending", "Taken in lieu", "Bank (h)"]);
  for (const m of d.activeMembers) {
    const yy = overtimeInYear(cal, model, m.id, y);
    const all = overtimeBalance(cal, d.model, m.id, archiveCarries());
    rows.push(["", name(m.id), yy.approved, yy.pending, yy.spent, Math.round(all.left * 100) / 100]);
  }
  rows.push([]);
  rows.push([`Balances ${y}`, "Entitlement", "Carried over", "Taken", "Pending", "Left", "Sick", "Remote"]);
  for (const m of d.activeMembers) {
    const b = balance(cal, model, m, y);
    rows.push([name(m.id), num(b.ent), num(b.carry), num(b.taken), num(b.pending), num(b.left), num(b.sick), num(b.remote)]);
  }
  try {
    await s.downloads.save({ filename: csvFilename(s.settings.teamName, y), data: toCSV(rows) });
    toast("Saved");
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "declined") return;
    toast("The export couldn’t be saved here.", true);
  }
}
