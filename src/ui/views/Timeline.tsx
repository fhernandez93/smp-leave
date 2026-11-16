import { useLayoutEffect, useMemo, useRef } from "react";
import { countedDays } from "../../domain/counting";
import { addDays, daysInMonth, fmtDate, fmtHours, fmtRange, fmtShort, iso, isLeap, MON3, num, parseISO, yearOf } from "../../domain/dates";
import { absencesOn, balance, overtimeBalance, type LeaveRecord } from "../../domain/model";
import { archiveCarries, openModal, recordsForYear } from "../../state/actions";
import { nameOf, useApp } from "../../state/store";
import { BookButton, Legend, OvertimeButton, TYPES, TYPE_COLOR, YearPicker } from "../common";

export function Timeline() {
  const [s, d] = useApp();
  const { cal, model } = d;
  const today = s.today;
  const thisYear = yearOf(today);

  const out = absencesOn(cal, model.leave, today);
  const soon: LeaveRecord[] = [];
  for (let i = 1; i <= 7; i++) {
    const day = iso(addDays(parseISO(today), i));
    for (const r of absencesOn(cal, model.leave, day)) if (!soon.includes(r) && !out.includes(r)) soon.push(r);
  }
  const me = d.me;
  const myBal = balance(cal, model, me, thisYear);
  const ot = overtimeBalance(cal, model, d.memberId ?? "", archiveCarries());
  const pend = model.records.filter((r) => r.status === "pending");
  const waiting = d.isApprover ? pend.length : pend.filter((r) => r.memberId === d.memberId).length;
  const hol = cal.holiday(today);

  return (
    <>
      <div className="today">
        <div>
          <div className="k">Your vacation left this year</div>
          <div className="v num" data-testid="my-left">{num(myBal.left)}<small>of {num(myBal.ent + myBal.carry)} days</small></div>
          {myBal.pending > 0 && <div className="tiny dim">{num(myBal.pending)} awaiting approval</div>}
        </div>
        <div>
          <div className="k">Away today</div>
          <div className="v num">{out.length}</div>
          {out.length ? (
            <div className="people">{out.map((r) => <span key={r.uid} className={`chip ${r.type}`}><span className="dot" />{nameOf(s, d, r.memberId)}</span>)}</div>
          ) : (
            <div className="tiny dim">{hol && hol.fraction >= 1 ? `${hol.name} — office closed` : "Everyone is in"}</div>
          )}
        </div>
        <div>
          <div className="k">Away in the next week</div>
          <div className="v num">{soon.length}</div>
          {soon.length > 0 && (
            <div className="people">{soon.slice(0, 8).map((r) => <span key={r.uid} className={`chip ${r.type}`}><span className="dot" />{nameOf(s, d, r.memberId)}, {fmtShort(r.start)}</span>)}</div>
          )}
        </div>
        <div>
          <div className="k">Overtime banked</div>
          <div className="v num">{fmtHours(ot.left)}{ot.left ? <small>{num(ot.left / cal.hoursPerDay())} days off in lieu</small> : null}</div>
          {ot.pending > 0 && <div className="tiny dim">{fmtHours(ot.pending)} awaiting approval</div>}
        </div>
        <div>
          <div className="k">{d.isApprover ? "Waiting for your decision" : "Your requests awaiting approval"}</div>
          <div className="v num">{waiting}</div>
          <div style={{ marginTop: 9, display: "flex", gap: 7, flexWrap: "wrap" }}><BookButton /><OvertimeButton /></div>
        </div>
      </div>
      <YearGrid />
    </>
  );
}

function YearGrid() {
  const [s, d] = useApp();
  const { cal } = d;
  const y = s.year;
  const today = s.today;
  const wrap = useRef<HTMLDivElement>(null);
  const dates = useMemo(() => {
    const n = isLeap(y) ? 366 : 365;
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(iso(addDays(new Date(Date.UTC(y, 0, 1)), i)));
    return out;
  }, [y]);
  const records = recordsForYear(y).filter((r): r is LeaveRecord => r.kind === "leave");
  const holMap = cal.holidaysFor(y);
  const members = d.activeMembers;
  const names = members.map((m) => nameOf(s, d, m.id));
  const namew = Math.min(170, Math.max(118, 10 + 7.6 * Math.max(8, ...names.map((n) => n.length))));

  // scroll to today once per year shown, not on every live update
  useLayoutEffect(() => {
    if (y !== yearOf(today) || !wrap.current) return;
    const idx = dates.indexOf(today);
    if (idx > 0) wrap.current.scrollLeft = Math.max(0, idx * 4 - wrap.current.clientWidth / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [y]);

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="hd">
        <h2>The year at a glance</h2>
        <span className="spacer" />
        <YearPicker />
      </div>
      <div className="tl-wrap" ref={wrap}>
        <div className="tl" style={{ ["--namew" as string]: `${namew}px` }}>
          <div className="tl-row months">
            <div className="tl-name">{y}</div>
            <div className="tl-days">
              {MON3.map((mo, m) => {
                const n = daysInMonth(y, m);
                return <div key={mo} className="mo" style={{ width: `calc(${n} * var(--dayw))` }}>{n >= 28 ? mo : mo[0]}</div>;
              })}
            </div>
          </div>
          {members.map((m, i) => {
            const byDate = new Map<string, { r: LeaveRecord; w: number }>();
            for (const r of records) {
              if (r.memberId !== m.id || r.status === "rejected" || r.status === "cancelled") continue;
              if (yearOf(r.end) < y || yearOf(r.start) > y) continue;
              for (const c of countedDays(cal, r)) if (yearOf(c.date) === y) byDate.set(c.date, { r, w: c.w });
            }
            const name = names[i]!;
            return (
              <div key={m.id}>
                <div className="tl-row" data-testid={`tl-${m.id}`}>
                  <div className="tl-name" title={name}>
                    {m.id === d.memberId && <span className="dot" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", flex: "0 0 auto" }} />}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                  </div>
                  <div className="tl-days">
                    {dates.map((ds) => {
                      const date = parseISO(ds);
                      const cls = ["d"];
                      if (date.getUTCDate() === 1) cls.push("m0");
                      const hol = holMap.get(ds);
                      const hit = byDate.get(ds);
                      let style: React.CSSProperties | undefined;
                      let title: string | undefined;
                      if (hit) {
                        cls.push(hit.r.type);
                        if (hit.r.status === "pending") cls.push("pend");
                        title = `${name} — ${TYPES[hit.r.type].label}, ${fmtRange(hit.r.start, hit.r.end)}${hit.w === 0.5 ? " (half day)" : ""}${hit.r.status === "pending" ? " (awaiting approval)" : ""}`;
                        style = { cursor: "pointer" };
                        if (hit.w === 0.5) style.background = `linear-gradient(to bottom, var(--${TYPE_COLOR[hit.r.type]}) 50%, transparent 50%)`;
                      } else if (hol && hol.fraction >= 1) cls.push("hol");
                      else if (!cal.isWorkday(date)) cls.push("we");
                      if (!hit && hol) {
                        title = `${fmtDate(ds)} — ${cal.holidayLabel(ds)}`;
                        if (hol.fraction < 1) style = { background: "linear-gradient(to bottom, transparent 50%, var(--hol) 50%)" };
                      }
                      if (ds === today) cls.push("today");
                      return <div key={ds} className={cls.join(" ")} title={title} style={style} onClick={hit ? () => openModal({ kind: "request", uid: hit.r.uid }) : undefined} />;
                    })}
                  </div>
                </div>
                <div className="tl-sep" />
              </div>
            );
          })}
        </div>
      </div>
      <div className="pad" style={{ paddingTop: 12 }}><Legend pendingNote="faded" /></div>
    </div>
  );
}
