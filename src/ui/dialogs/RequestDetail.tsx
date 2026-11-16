import { totalDays } from "../../domain/counting";
import { fmtRange, plural } from "../../domain/dates";
import type { LeaveRecord } from "../../domain/model";
import { canDecide, canWithdraw, closeModal, decide, recordsForYear } from "../../state/actions";
import { nameOf, useApp } from "../../state/store";
import { Flags, StatusChip, TypeChip } from "../common";
import { askCancel, askDecline } from "../views/Requests";
import { Modal } from "./ModalHost";

export function RequestDetail({ uid }: { uid: string }) {
  const [s, d] = useApp();
  const r = [...d.model.records, ...recordsForYear(s.year)].find((x): x is LeaveRecord => x.uid === uid && x.kind === "leave");
  if (!r) return <Modal title="Leave details"><p className="muted small">This booking is no longer here.</p></Modal>;
  const days = totalDays(d.cal, r);
  const mine = r.memberId === d.memberId;
  const decidable = canDecide(r);
  const live = d.model.records.includes(r);
  const editorCancel = live && d.isApprover && r.status !== "cancelled" && r.status !== "rejected";

  return (
    <Modal title="Leave details" foot={<>
      <span className="spacer" />
      {decidable ? (
        <>
          <button className="btn danger" type="button" onClick={() => askDecline(r, nameOf(s, d, r.memberId))}>Decline</button>
          <button className="btn primary" type="button" onClick={() => { void decide(r, "approved"); closeModal(); }}>Approve</button>
        </>
      ) : live && canWithdraw(r) ? (
        <button className="btn" type="button" onClick={() => askCancel(r, nameOf(s, d, r.memberId), true)}>Cancel this leave</button>
      ) : editorCancel ? (
        <button className="btn" type="button" onClick={() => askCancel(r, nameOf(s, d, r.memberId), false)}>Cancel this leave</button>
      ) : mine && live && r.status === "approved" ? (
        <span className="tiny dim">It has started — ask an approver to cancel it.</span>
      ) : null}
      <button className="btn ghost" type="button" onClick={closeModal}>Close</button>
    </>}>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
        <TypeChip type={r.type} /><StatusChip r={r} />{d.isApprover && <Flags r={r} />}
      </div>
      <div className="num" style={{ fontSize: 17, fontWeight: 600 }}>{fmtRange(r.start, r.end)}</div>
      <div className="muted small num" style={{ marginTop: 2 }}>
        {plural(days, "working day", "working days")}
        {r.halfStart && r.start === r.end ? (r.halfPeriod === "pm" ? " — afternoon" : " — morning") : r.halfStart || r.halfEnd ? " (includes a half day)" : ""}
      </div>
      <table style={{ marginTop: 14 }}>
        <tbody>
          <tr><td className="muted" style={{ width: "42%" }}>Person</td><td>{nameOf(s, d, r.memberId)}</td></tr>
          <tr><td className="muted">Requested</td><td className="num">{(r.createdAt ?? "").slice(0, 10) || "—"}</td></tr>
          {r.createdBy && r.createdBy !== r.memberId && <tr><td className="muted">Entered by</td><td>{nameOf(s, d, r.createdBy)}</td></tr>}
          {r.decision && !r.auto && r.decision.by && (
            <tr><td className="muted">Decided by</td><td>{nameOf(s, d, r.decision.by)} on {(r.decision.at ?? "").slice(0, 10)}</td></tr>
          )}
          {!live && <tr><td className="muted">Archived</td><td>Read-only</td></tr>}
        </tbody>
      </table>
      {r.note && <div className="note" style={{ marginTop: 12 }}>{r.note}</div>}
      {r.decision?.note && <div className="note" style={{ marginTop: 8 }}>Approver: {r.decision.note}</div>}
    </Modal>
  );
}
