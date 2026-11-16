import { totalDays } from "../../domain/counting";
import { fmtDate, fmtHours, fmtRange, num, plural } from "../../domain/dates";
import type { LeaveOrOvertime, LeaveRecord, OvertimeRecord } from "../../domain/model";
import { canDecide, canWithdraw, decide, openModal, recordsForYear, setFilter, withdraw } from "../../state/actions";
import { nameOf, useApp, type ReqFilter } from "../../state/store";
import { BookButton, Empty, Flags, OvertimeButton, StatusChip, TypeChip } from "../common";
import { exportCSV } from "./Balances";

const FILTERS: [ReqFilter, string][] = [
  ["all", "All"], ["pending", "Awaiting approval"], ["mine", "Mine"], ["upcoming", "Upcoming"],
  ["vacation", "Vacation"], ["overtime", "Overtime"], ["comp", "Time off in lieu"], ["sick", "Sick"], ["remote", "Remote"],
];

export function Requests() {
  const [s, d] = useApp();
  const f = s.reqFilter;
  const today = s.today;
  const filters = d.isApprover ? [...FILTERS, ["flagged", "Needs a look"] as [ReqFilter, string]] : FILTERS;
  const all = s.settings.archivedBefore != null && s.year < s.settings.archivedBefore ? recordsForYear(s.year) : d.model.records;

  let rows: LeaveOrOvertime[] = all.filter((r) => {
    if (f === "overtime") return r.kind === "overtime";
    if (f === "pending") return r.status === "pending";
    if (f === "mine") return r.memberId === d.memberId;
    if (f === "flagged") return r.flags.length > 0;
    if (f === "upcoming") return r.kind === "leave" && r.end >= today && r.status !== "cancelled" && r.status !== "rejected";
    if (f === "vacation" || f === "sick" || f === "remote" || f === "comp") return r.kind === "leave" && r.type === f;
    return true;
  });
  const key = (r: LeaveOrOvertime) => (r.kind === "leave" ? r.start : r.date);
  const forwards = f === "pending" || f === "upcoming";
  rows = [...rows].sort((a, b) => (forwards ? key(a).localeCompare(key(b)) : key(b).localeCompare(key(a))));

  return (
    <div className="panel">
      <div className="hd" style={{ flexWrap: "wrap" }}>
        <div className="seg" style={{ maxWidth: "100%", overflowX: "auto" }}>
          {filters.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={f === id} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <span className="spacer" />
        {s.downloads && <button className="btn sm" type="button" onClick={() => void exportCSV()}>Export CSV</button>}
        <OvertimeButton />
        <BookButton />
      </div>
      {rows.length === 0 ? (
        <Empty title="Nothing here yet">
          {f === "pending" ? "Nothing is waiting on a decision." : f === "overtime" ? "Log extra hours and they land here for approval." : "Book leave and it will show up in this list."}
        </Empty>
      ) : (
        rows.map((r) => (r.kind === "overtime" ? <OvertimeRow key={r.uid} o={r} /> : <RequestRow key={r.uid} r={r} />))
      )}
    </div>
  );
}

function withWho(approverCount: number) {
  return approverCount ? "With an approver" : "With nobody — mark an approver in Team";
}

export function RequestRow({ r }: { r: LeaveRecord }) {
  const [s, d] = useApp();
  const mine = r.memberId === d.memberId;
  const days = totalDays(d.cal, r);
  const decidable = canDecide(r);
  const editorCancel = d.isApprover && r.status !== "cancelled" && r.status !== "rejected" && r.end >= s.today;
  return (
    <div className="req" data-testid={`req-${r.id}`}>
      <div className="body">
        <div className="who">{nameOf(s, d, r.memberId)}{mine && <span className="dim"> (you)</span>}</div>
        <div className="meta num">
          {fmtRange(r.start, r.end)} · {plural(days, "day", "days")}
          {r.halfStart && r.start === r.end ? (r.halfPeriod === "pm" ? " · afternoon" : " · morning") : ""}
        </div>
        <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
          <TypeChip type={r.type} />
          <StatusChip r={r} />
          {d.isApprover && <Flags r={r} />}
        </div>
        {r.note && <div className="note">{r.note}</div>}
        {r.decision?.note && <div className="note">Approver: {r.decision.note}</div>}
      </div>
      <div className="acts">
        {decidable && (
          <>
            <button className="btn sm primary" type="button" onClick={() => void decide(r, "approved")}>Approve</button>
            <button className="btn sm danger" type="button" onClick={() => askDecline(r, nameOf(s, d, r.memberId))}>Decline</button>
          </>
        )}
        {!decidable && r.status === "pending" && mine && <span className="tiny dim">{withWho(d.approverCount)}</span>}
        {d.isApprover && r.flags.includes("withdrawal-unconfirmed") && (
          <button className="btn sm" type="button" onClick={() => void decide(r, "cancelled")}>Confirm cancellation</button>
        )}
        {canWithdraw(r) ? (
          <button className="btn sm ghost" type="button" onClick={() => askCancel(r, nameOf(s, d, r.memberId), true)}>Cancel</button>
        ) : editorCancel && !r.flags.includes("withdrawal-unconfirmed") ? (
          <button className="btn sm ghost" type="button" onClick={() => askCancel(r, nameOf(s, d, r.memberId), false)}>Cancel</button>
        ) : null}
        <button className="btn sm ghost" type="button" onClick={() => openModal({ kind: "request", uid: r.uid })}>Details</button>
      </div>
    </div>
  );
}

export function askDecline(r: LeaveOrOvertime, who: string) {
  openModal({
    kind: "ask",
    title: r.kind === "overtime" ? "Decline these hours" : "Decline this leave",
    label: `Reason (optional — ${who} will see it)`,
    placeholder: r.kind === "overtime" ? "e.g. already compensated in the monthly total" : "e.g. clashes with the beamtime run",
    ok: "Decline",
    danger: true,
    onOk: (v) => decide(r, "rejected", v),
  });
}

export function askCancel(r: LeaveOrOvertime, who: string, own: boolean) {
  const what = r.kind === "leave" ? `${fmtRange(r.start, r.end)} for ${who}.` : `${fmtHours(r.hours)} on ${fmtDate(r.date)} for ${who}.`;
  openModal({
    kind: "ask",
    title: r.kind === "overtime" ? "Remove this overtime?" : "Cancel this leave?",
    text: r.kind === "leave" ? `${what} The days go back into the balance.` : what,
    ok: r.kind === "overtime" ? "Remove" : "Cancel the leave",
    danger: true,
    onOk: () => (own ? withdraw(r) : decide(r, "cancelled")),
  });
}

export function OvertimeRow({ o }: { o: OvertimeRecord }) {
  const [s, d] = useApp();
  const mine = o.memberId === d.memberId;
  const decidable = canDecide(o);
  return (
    <div className="req" data-testid={`ot-${o.id}`}>
      <div className="body">
        <div className="who">{nameOf(s, d, o.memberId)}{mine && <span className="dim"> (you)</span>}</div>
        <div className="meta num">
          {fmtDate(o.date)} · {fmtHours(o.hours)}
          {o.status === "approved" && <span className="dim"> · {num(o.hours / d.cal.hoursPerDay())} days in lieu</span>}
        </div>
        <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
          <TypeChip type="overtime" />
          <StatusChip r={o} />
          {d.isApprover && <Flags r={o} />}
        </div>
        {o.note && <div className="note">{o.note}</div>}
        {o.decision?.note && <div className="note">Approver: {o.decision.note}</div>}
      </div>
      <div className="acts">
        {decidable && (
          <>
            <button className="btn sm primary" type="button" onClick={() => void decide(o, "approved")}>Approve</button>
            <button className="btn sm danger" type="button" onClick={() => askDecline(o, nameOf(s, d, o.memberId))}>Decline</button>
          </>
        )}
        {!decidable && o.status === "pending" && mine && <span className="tiny dim">{withWho(d.approverCount)}</span>}
        {(canWithdraw(o) || (d.isApprover && o.status !== "cancelled")) && (
          <button className="btn sm ghost" type="button" onClick={() => askCancel(o, nameOf(s, d, o.memberId), canWithdraw(o))}>Remove</button>
        )}
      </div>
    </div>
  );
}
