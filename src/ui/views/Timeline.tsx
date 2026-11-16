import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { initials, personColors } from "../../domain/colors";
import { countedDays } from "../../domain/counting";
import {
  addDays, datesBetween, daysInMonth, DOW, fmtDate, fmtHours, fmtRange, fmtShort, iso, isoWeek, MON3, mondayIndex, mondayOf,
  MONTHS, num, parseISO, weekForMonth, yearOf,
} from "../../domain/dates";
import { absencesOn, balance, overtimeBalance, type LeaveRecord } from "../../domain/model";
import type { ISODate } from "../../domain/types";
import { archiveCarries, loadArchivedYear, openModal, recordsForYear, setCalMonth, setTlView, setTlWeek, setYear } from "../../state/actions";
import { nameOf, TL_VIEWS, useApp, type TlView } from "../../state/store";
import { BookButton, Legend, OvertimeButton, TYPES, TYPE_COLOR } from "../common";

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
      <LeaveGrid />
    </>
  );
}

const VIEW_LABEL: Record<TlView, string> = { year: "Year", month: "Month", week: "Week" };

interface Hit { r: LeaveRecord; w: number }

/** "Leaves at a glance": everyone's absences for a year, a month or a week. */
function LeaveGrid() {
  const [s, d] = useApp();
  const { cal } = d;
  const view = s.tlView;
  const today = s.today;
  const y = s.year, m = s.calMonth;
  const week = view === "week" ? weekForMonth(y, m, today, s.tlWeek) : null;

  // the range shown
  let start: ISODate, end: ISODate, period: string;
  if (view === "year") {
    start = `${y}-01-01`; end = `${y}-12-31`; period = String(y);
  } else if (view === "month") {
    start = iso(new Date(Date.UTC(y, m, 1))); end = iso(new Date(Date.UTC(y, m, daysInMonth(y, m)))); period = `${MONTHS[m]} ${y}`;
  } else {
    start = week!; end = iso(addDays(parseISO(week!), 6)); period = fmtRange(start, end);
  }

  const step = (n: -1 | 1) => {
    if (view === "year") setYear(y + n);
    else if (view === "month") {
      const mm = m + n;
      setCalMonth(mm < 0 ? y - 1 : mm > 11 ? y + 1 : y, (mm + 12) % 12);
    } else setTlWeek(iso(addDays(parseISO(week!), 7 * n)));
  };
  const [scrollNonce, setScrollNonce] = useState(0);
  const goToday = () => {
    const ty = yearOf(today), tm = parseISO(today).getUTCMonth();
    if (view === "year") setYear(ty);
    else if (view === "month") setCalMonth(ty, tm);
    else setTlWeek(mondayOf(today));
    setScrollNonce((x) => x + 1);
  };

  // a week or month crossing New Year needs the previous year's archive too
  const archivedBefore = s.settings.archivedBefore;
  useEffect(() => { void loadArchivedYear(yearOf(start)); }, [start, archivedBefore, s.db]);

  const dates = useMemo(() => datesBetween(start, end), [start, end]);
  const members = d.activeMembers;
  const names = members.map((mb) => nameOf(s, d, mb.id));
  // d.activeMembers is rebuilt on every store change; the colours depend only on the roster
  const colors = useMemo(() => personColors(s.members, s.members.filter((mb) => !mb.archived)), [s.members]);
  // padding + badge + text + "(you)"
  const namew = Math.min(240, Math.max(150, 67 + 7.6 * Math.max(8, ...names.map((n) => n.length)) + (d.memberId ? 40 : 0)));

  // who is away on which day, per member; recomputed only when the data or the range change
  const byMember = useMemo(() => {
    const records = recordsForYear(yearOf(start)).filter((r): r is LeaveRecord => r.kind === "leave");
    const out = new Map<string, Map<string, Hit>>();
    for (const r of records) {
      if (r.status === "rejected" || r.status === "cancelled") continue;
      if (r.end < start || r.start > end) continue;
      let mm = out.get(r.memberId);
      if (!mm) out.set(r.memberId, (mm = new Map()));
      for (const c of countedDays(cal, r)) if (c.date >= start && c.date <= end) mm.set(c.date, { r, w: c.w });
    }
    return out;
    // recordsForYear reads the store; these are the inputs it depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.model.records, s.archived, archivedBefore, cal, start, end]);

  // keep today in view (year and month views scroll sideways), or start at the left edge
  const wrap = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const w = wrap.current;
    if (!w) return;
    const cell = w.querySelector<HTMLElement>(".tl-days .d.is-today");
    if (!cell || view === "week") { w.scrollLeft = 0; return; }
    const name = w.querySelector<HTMLElement>(".tl-name");
    const nw = name?.getBoundingClientRect().width ?? 0;
    const left = cell.getBoundingClientRect().left - w.getBoundingClientRect().left + w.scrollLeft;
    w.scrollLeft = Math.max(0, left - nw - (w.clientWidth - nw) / 2);
  }, [view, start, scrollNonce]);

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="hd tl-hd">
        <h2>Leaves at a glance</h2>
        <span className="spacer" />
        <div className="seg tl-views" role="group" aria-label="Timeline view">
          {TL_VIEWS.map((v) => (
            <button key={v} type="button" aria-pressed={view === v} data-testid={`tl-view-${v}`} onClick={() => setTlView(v)}>{VIEW_LABEL[v]}</button>
          ))}
        </div>
      </div>
      <div className="tl-nav">
        <button className="btn sm ghost" type="button" aria-label={`Previous ${view}`} onClick={() => step(-1)}>‹</button>
        <span className="period" aria-live="polite" data-testid="tl-period">{period}</span>
        <button className="btn sm ghost" type="button" aria-label={`Next ${view}`} onClick={() => step(1)}>›</button>
        <button className="btn sm" type="button" onClick={goToday}>Today</button>
        {week && <span className="tiny dim wk">Week {isoWeek(week)}</span>}
      </div>
      <div className="tl-wrap" ref={wrap} style={{ ["--namew-full" as string]: `${namew}px` }}>
        <div className={`tl v-${view}`} data-testid="tl-grid">
          <HeaderRow view={view} dates={dates} y={y} today={today} />
          {members.map((mb, i) => (
            <Row key={mb.id} id={mb.id} name={names[i]!} color={colors.get(mb.id) ?? 0} me={mb.id === d.memberId}
              view={view} dates={dates} hits={byMember.get(mb.id)} today={today} />
          ))}
        </div>
      </div>
      <div className="pad" style={{ paddingTop: 12 }}>
        {view === "week" ? <Legend pendingNote="dashed" closures /> : <Legend pendingNote="faded" />}
      </div>
    </div>
  );
}

function HeaderRow({ view, dates, y, today }: { view: TlView; dates: ISODate[]; y: number; today: ISODate }) {
  if (view === "year") {
    return (
      <div className="tl-row months">
        <div className="tl-name" aria-hidden="true" />
        <div className="tl-days">
          {MON3.map((mo, mi) => {
            const n = daysInMonth(y, mi);
            return <div key={mo} className="mo" style={{ width: `calc(${n} * var(--dayw))` }}>{mo}</div>;
          })}
        </div>
      </div>
    );
  }
  return (
    <div className="tl-row days">
      <div className="tl-name" aria-hidden="true" />
      <div className="tl-days">
        {dates.map((ds) => {
          const dt = parseISO(ds);
          const dow = DOW[mondayIndex(dt)]!;
          return (
            <div key={ds} className={`dh${ds === today ? " now" : ""}${mondayIndex(dt) >= 5 ? " wkend" : ""}`} title={fmtDate(ds)}>
              {view === "week" ? <>{dow} <b>{dt.getUTCDate()}</b></> : <><span>{dow[0]}</span><b>{dt.getUTCDate()}</b></>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function open(uid: string) {
  openModal({ kind: "request", uid });
}

function Row({ id, name, color, me, view, dates, hits, today }: {
  id: string; name: string; color: number; me: boolean; view: TlView; dates: ISODate[]; hits: Map<string, Hit> | undefined; today: ISODate;
}) {
  const [, d] = useApp();
  const { cal } = d;
  const seen = new Set<string>();
  let prev: string | undefined;
  /** how many cells in a row, from index i, show the same booking (a week-view label may span them) */
  const runFrom = (i: number, uid: string) => {
    let n = 1;
    while (i + n < dates.length && hits?.get(dates[i + n]!)?.r.uid === uid) n++;
    return n;
  };
  const cells = dates.map((ds, i) => {
    const date = parseISO(ds);
    const cls = ["d"];
    if (view === "year" && date.getUTCDate() === 1) cls.push("m0");
    if (view !== "year" && mondayIndex(date) === 0) cls.push("w0");
    const hol = cal.holiday(ds);
    const hit = hits?.get(ds);
    let style: React.CSSProperties | undefined;
    let title: string | undefined;
    let label: string | null = null;
    let run = 1;
    let focusable = false;
    if (hit) {
      const r = hit.r;
      cls.push(r.type);
      if (r.status === "pending") cls.push("pend");
      title = `${name} — ${TYPES[r.type].label}, ${fmtRange(r.start, r.end)}${hit.w === 0.5 ? " (half day)" : ""}${r.status === "pending" ? " (awaiting approval)" : ""}`;
      style = { cursor: "pointer" };
      const soft = view === "week" ? "-soft" : "";
      if (hit.w === 0.5) style.background = `linear-gradient(to bottom, var(--${TYPE_COLOR[r.type]}${soft}) 50%, transparent 50%)`;
      // one tab stop per booking; in the week view, a label at the start of each run
      focusable = !seen.has(r.uid);
      seen.add(r.uid);
      if (view === "week" && prev !== r.uid) {
        label = `${TYPES[r.type].short ?? TYPES[r.type].label}${hit.w === 0.5 ? " ½" : ""}`;
        run = runFrom(i, r.uid);
      }
    } else if (hol && hol.fraction >= 1) cls.push("hol");
    else if (!cal.isWorkday(date)) cls.push("we");
    if (!hit && hol) {
      title = `${fmtDate(ds)} — ${cal.holidayLabel(ds)}`;
      if (hol.fraction < 1) style = { background: "linear-gradient(to bottom, transparent 50%, var(--hol) 50%)" };
    }
    if (ds === today) cls.push("is-today"); // not "today": that class styles the summary cards above
    prev = hit?.r.uid;
    const uid = hit?.r.uid;
    return (
      <div key={ds} className={cls.join(" ")} title={title} style={style}
        onClick={uid ? () => open(uid) : undefined}
        {...(focusable && uid ? {
          role: "button", tabIndex: 0, "aria-label": title,
          onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(uid); } },
        } : {})}>
        {label && <span className="lbl" style={run > 1 ? { maxWidth: `${run * 100}%` } : undefined}>{label}</span>}
      </div>
    );
  });
  return (
    <div>
      <div className="tl-row" data-testid={`tl-${id}`}>
        <div className={`tl-name${me ? " me" : ""}`} title={me ? `${name} (you)` : name}>
          <span className="pbadge" style={{ background: `var(--p${color})` }} aria-hidden="true" data-testid={`tl-badge-${id}`}>{initials(name)}</span>
          <span className="nm">{name}</span>
          {me && <span className="you">(you)</span>}
        </div>
        <div className="tl-days">{cells}</div>
      </div>
      <div className="tl-sep" />
    </div>
  );
}
