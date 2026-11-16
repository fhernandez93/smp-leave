import { useState } from "react";
import { fmtHours, isISODate, num, parseISO } from "../../domain/dates";
import { overtimeBalance } from "../../domain/model";
import { archiveCarries, closeModal, logOvertime, NOTE_MAX } from "../../state/actions";
import { nameOf, useApp } from "../../state/store";
import { Modal } from "./ModalHost";

export function Overtime({ date }: { date?: string }) {
  const [s, d] = useApp();
  const { cal } = d;
  const [memberId, setMemberId] = useState(d.memberId ?? "");
  const [day, setDay] = useState(date ?? s.today);
  const [hours, setHours] = useState("2");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const hrs = Number(hours);
  const ok = isISODate(day) && hrs > 0 && hrs <= 24;
  const bal = overtimeBalance(cal, d.model, memberId, archiveCarries());
  const hol = ok ? cal.holiday(day) : null;

  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    const done = await logOvertime(memberId, day, hrs, note);
    setBusy(false);
    if (done) closeModal();
  };

  return (
    <Modal title="Log overtime" foot={<>
      <span className="spacer" />
      <button className="btn" type="button" onClick={closeModal}>Cancel</button>
      <button className="btn primary" type="button" disabled={!ok || busy} onClick={() => void submit()}>Send for approval</button>
    </>}>
      {s.isAdmin && d.activeMembers.length > 1 && (
        <label className="field"><span>Who worked them</span>
          <select id="ot-who" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            {d.activeMembers.map((m) => <option key={m.id} value={m.id}>{nameOf(s, d, m.id)}{m.id === d.memberId ? " (you)" : ""}</option>)}
          </select>
        </label>
      )}
      <div className="row2">
        <label className="field"><span>Day</span><input id="ot-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>
        <label className="field"><span>Hours beyond the contract</span><input id="ot-hours" type="number" step="0.25" min="0.25" max="16" value={hours} onChange={(e) => setHours(e.target.value)} /></label>
      </div>
      <div className="seg" style={{ marginTop: 8 }}>
        {[1, 2, 4, 8].map((v) => <button key={v} type="button" aria-pressed={hrs === v} onClick={() => setHours(String(v))}>{v} h</button>)}
      </div>
      <div style={{ height: 14 }} />
      <div className="calc">
        {!ok ? <span className="bad">Enter a date and a number of hours.</span> : (
          <>
            <div>Worth <b>{num(hrs / cal.hoursPerDay())}</b>{hrs / cal.hoursPerDay() === 1 ? " day off in lieu" : " days off in lieu"} at {num(cal.hoursPerDay())} h a day.</div>
            <span className="tiny dim" style={{ display: "block", marginTop: 4 }}>The bank holds {fmtHours(bal.left)} now, and {fmtHours(bal.left + hrs)} once this is approved.</span>
            {hol ? <span className="tiny dim" style={{ display: "block", marginTop: 4 }}>That day is {cal.holidayLabel(day)}.</span>
              : !cal.isWorkday(parseISO(day)) ? <span className="tiny dim" style={{ display: "block", marginTop: 4 }}>That is a weekend.</span> : null}
            <span className="warn">Every overtime entry goes to an approver before it counts.</span>
          </>
        )}
      </div>
      <label className="field"><span>Reason</span><textarea id="ot-note" maxLength={NOTE_MAX} placeholder="What the extra hours were for — beamtime, a deadline, a weekend measurement" value={note} onChange={(e) => setNote(e.target.value)} /></label>
    </Modal>
  );
}
