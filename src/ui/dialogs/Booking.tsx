import { useState } from "react";
import { totalDays } from "../../domain/counting";
import { addDays, fmtHours, iso, num, overlaps, parseISO, yearOf } from "../../domain/dates";
import { balance, overtimeBalance, runDaysWith } from "../../domain/model";
import { LEAVE_TYPES, type LeaveType } from "../../domain/types";
import { archiveCarries, bookLeave, closeModal, NOTE_MAX } from "../../state/actions";
import { nameOf, useApp } from "../../state/store";
import { TYPES } from "../common";
import { Modal } from "./ModalHost";

export function Booking({ start }: { start?: string }) {
  const [s, d] = useApp();
  const { cal, model } = d;
  const first = start ?? s.today;
  const [memberId, setMemberId] = useState(d.memberId ?? "");
  const [type, setType] = useState<LeaveType>("vacation");
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(first);
  const [halfA, setHalfA] = useState(false);
  const [halfB, setHalfB] = useState(false);
  const [period, setPeriod] = useState<"am" | "pm">("am");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const single = from === to;
  const draft = { memberId, type, start: from, end: to, halfStart: halfA, halfEnd: halfB && !single, halfPeriod: halfA && single ? period : null, note };
  const valid = !!from && !!to && to >= from;
  const days = valid ? totalDays(cal, draft) : 0;
  const runDays = valid ? runDaysWith(cal, model, draft) : 0;
  const needsApproval = (type === "vacation" || type === "comp") && runDays > Number(s.settings.approvalThreshold || 0);
  const archived = s.settings.archivedBefore != null && valid && yearOf(to) < s.settings.archivedBefore;

  const calc: React.ReactNode[] = [];
  let ok = valid && !archived;
  if (!valid) calc.push(<span key="bad" className="bad">The end date is before the start date.</span>);
  else if (archived) calc.push(<span key="arch" className="bad">{yearOf(to)} is archived. Bookings there can’t be added any more.</span>);
  else if (days <= 0) { ok = false; calc.push(<span key="none" className="bad">That range has no working days in it.</span>); }
  else {
    const closed: string[] = [], halves: string[] = [];
    for (let x = parseISO(from); x <= parseISO(to); x = addDays(x, 1)) {
      const h = cal.isWorkday(x) ? cal.holiday(iso(x)) : null;
      if (h) (h.fraction >= 1 ? closed : halves).push(h.name);
    }
    calc.push(<div key="uses">This uses <b>{num(days)}</b>{days === 1 ? " working day" : " working days"}{TYPES[type].deducts ? "" : TYPES[type].spendsOvertime ? " from your overtime bank" : " and does not touch the vacation balance"}.</div>);
    if (closed.length) calc.push(<span key="cl" className="tiny dim" style={{ display: "block", marginTop: 4 }}>Free anyway: {[...new Set(closed)].join(", ")}</span>);
    if (halves.length) calc.push(<span key="hv" className="tiny dim" style={{ display: "block", marginTop: 4 }}>Counted as a half day: {[...new Set(halves)].join(", ")} — the State already gives the afternoon.</span>);
    if (TYPES[type].spendsOvertime) {
      const bank = overtimeBalance(cal, model, memberId, archiveCarries());
      const cost = days * cal.hoursPerDay();
      const after = bank.left - cost;
      calc.push(<span key="bank" className={after < 0 ? "bad" : "tiny dim"} style={{ display: "block", marginTop: 4 }}>
        {after < 0 ? `That costs ${fmtHours(cost)}, and only ${fmtHours(bank.left)} is banked.` : `Costs ${fmtHours(cost)} of the ${fmtHours(bank.left)} banked, leaving ${fmtHours(after)}.`}
      </span>);
      if (!bank.banked) calc.push(<span key="nob" className="warn">No approved overtime yet — log the hours first and have them approved.</span>);
    }
    if (TYPES[type].deducts) {
      const m = s.members.find((x) => x.id === memberId) ?? null;
      const left = balance(cal, model, m, yearOf(from)).left - days;
      calc.push(<span key="left" className={left < 0 ? "bad" : "tiny dim"} style={{ display: "block", marginTop: 4 }}>
        {left < 0 ? `That is ${num(-left)} more than ${nameOf(s, d, memberId)} has left this year.` : `${num(left)} vacation days would remain in ${yearOf(from)}.`}
      </span>);
    }
    const clash = model.leave.filter((r) => r.memberId !== memberId && r.status !== "rejected" && r.status !== "cancelled" && overlaps(r, draft));
    if (clash.length) calc.push(<span key="clash" className="warn">Also away then: {[...new Set(clash.map((r) => nameOf(s, d, r.memberId)))].join(", ")}</span>);
    if (needsApproval) {
      calc.push(<span key="appr" className="warn">
        {runDays > days ? `Together with your booking next to it that makes ${num(runDays)} days in a row, ` : `Longer than ${num(s.settings.approvalThreshold)} days, `}so it goes to an approver.
      </span>);
    }
  }

  const submit = async () => {
    if (!ok || days <= 0) return;
    setBusy(true);
    const done = await bookLeave(draft, needsApproval);
    setBusy(false);
    if (done) closeModal();
  };

  return (
    <Modal title="Book time away" foot={<>
      <span className="spacer" />
      <button className="btn" type="button" onClick={closeModal}>Cancel</button>
      <button className="btn primary" type="button" disabled={!ok || days <= 0 || busy} onClick={() => void submit()}>{needsApproval ? "Send for approval" : "Book"}</button>
    </>}>
      {s.isAdmin && d.activeMembers.length > 1 && (
        <label className="field"><span>Who is away</span>
          <select id="book-who" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            {d.activeMembers.map((m) => <option key={m.id} value={m.id}>{nameOf(s, d, m.id)}{m.id === d.memberId ? " (you)" : ""}</option>)}
          </select>
        </label>
      )}
      <label className="field"><span>Type</span>
        <div className="seg">
          {LEAVE_TYPES.map((k) => <button key={k} type="button" aria-pressed={k === type} onClick={() => setType(k)}>{TYPES[k].short ?? TYPES[k].label}</button>)}
        </div>
      </label>
      <div className="row2">
        <label className="field"><span>From</span><input id="book-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} /></label>
        <label className="field"><span>To</span><input id="book-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <label className="check"><input id="book-half-a" type="checkbox" checked={halfA} onChange={(e) => setHalfA(e.target.checked)} />
        <span>{single ? "Half day" : "First day is a half day (you leave at midday)"}</span></label>
      {single && halfA && (
        <div className="seg" style={{ maxWidth: 230, margin: "-2px 0 10px 26px" }}>
          <button type="button" aria-pressed={period === "am"} onClick={() => setPeriod("am")}>Morning</button>
          <button type="button" aria-pressed={period === "pm"} onClick={() => setPeriod("pm")}>Afternoon</button>
        </div>
      )}
      {!single && (
        <label className="check"><input id="book-half-b" type="checkbox" checked={halfB} onChange={(e) => setHalfB(e.target.checked)} />
          <span>Last day is a half day (you are back at midday)</span></label>
      )}
      <div className="calc" data-testid="booking-calc">{calc}</div>
      <label className="field"><span>Note</span><textarea id="book-note" maxLength={NOTE_MAX} placeholder="Anything the team should know (optional)" value={note} onChange={(e) => setNote(e.target.value)} /></label>
    </Modal>
  );
}
