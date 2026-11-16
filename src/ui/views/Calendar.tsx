import { addDays, daysInMonth, DOW, fmtDate, iso, mondayIndex, MONTHS } from "../../domain/dates";
import { absencesOn, type LeaveRecord } from "../../domain/model";
import { weightOn } from "../../domain/counting";
import { openModal, recordsForYear, setCalMonth } from "../../state/actions";
import { nameOf, useApp } from "../../state/store";
import { BookButton, Legend, TYPES } from "../common";

export function Calendar() {
  const [s, d] = useApp();
  const { cal } = d;
  const y = s.year, m = s.calMonth;
  const step = (n: number) => {
    let mm = s.calMonth + n, yy = s.year;
    if (mm < 0) { mm = 11; yy--; } else if (mm > 11) { mm = 0; yy++; }
    setCalMonth(yy, mm);
  };
  const first = new Date(Date.UTC(y, m, 1));
  const lead = mondayIndex(first);
  const rows = Math.ceil((lead + daysInMonth(y, m)) / 7) * 7;
  const records = recordsForYear(y).filter((r): r is LeaveRecord => r.kind === "leave");

  const cells = [];
  for (let i = 0; i < rows; i++) {
    const date = addDays(first, i - lead);
    const ds = iso(date);
    const inMonth = date.getUTCMonth() === m;
    const cls = ["cell"];
    if (!inMonth) cls.push("out");
    if (!cal.isWorkday(date)) cls.push("we");
    const hol = cal.holiday(ds);
    if (hol) { cls.push("holiday"); if (hol.fraction < 1) cls.push("half"); }
    if (ds === s.today) cls.push("istoday");
    const bookable = inMonth && cal.isWorkday(date) && (!hol || hol.fraction < 1);
    const abs = bookable ? absencesOn(cal, records, ds) : [];
    const canClickToBook = bookable && !abs.length && d.canBook;
    cells.push(
      <div key={ds} className={cls.join(" ")} data-date={ds} style={canClickToBook ? { cursor: "pointer" } : undefined}
        title={canClickToBook ? `Book leave on ${fmtDate(ds)}` : undefined}
        onClick={canClickToBook ? () => openModal({ kind: "booking", start: ds }) : undefined}>
        <div className="n"><b>{date.getUTCDate()}</b>{hol && hol.fraction < 1 && <span className="halfmark" title="Half day off">½</span>}</div>
        {hol && <div className="holname">{cal.holidayLabel(ds)}</div>}
        {abs.length > 0 && (
          <ul>
            {abs.slice(0, 5).map((r) => {
              const w = weightOn(cal, r, ds);
              const who = nameOf(s, d, r.memberId);
              return (
                <li key={r.uid} className={r.type + (r.status === "pending" ? " pend" : "")} style={{ cursor: "pointer" }}
                  title={`${who} — ${TYPES[r.type].label}${r.status === "pending" ? ", awaiting approval" : ""}`}
                  onClick={(e) => { e.stopPropagation(); openModal({ kind: "request", uid: r.uid }); }}>
                  {who}{w === 0.5 ? " ½" : ""}
                </li>
              );
            })}
            {abs.length > 5 && <li className="dim">+{abs.length - 5} more</li>}
          </ul>
        )}
      </div>,
    );
  }

  return (
    <div className="panel">
      <div className="hd">
        <button className="btn sm ghost" type="button" aria-label="Previous month" onClick={() => step(-1)}>‹</button>
        <h2 style={{ minWidth: 150 }}>{MONTHS[m]} {y}</h2>
        <button className="btn sm ghost" type="button" aria-label="Next month" onClick={() => step(1)}>›</button>
        <span className="spacer" />
        <button className="btn sm" type="button" onClick={() => { const n = new Date(); setCalMonth(n.getFullYear(), n.getMonth()); }}>Today</button>
        <BookButton />
      </div>
      <div className="cal">
        {DOW.map((x) => <div key={x} className="dow">{x}</div>)}
        {cells}
      </div>
      <div className="pad"><Legend pendingNote="dashed" /></div>
    </div>
  );
}
