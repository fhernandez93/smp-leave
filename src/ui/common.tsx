import type { ReactNode } from "react";
import type { LeaveOrOvertime } from "../domain/model";
import type { LeaveType } from "../domain/types";
import { openModal, setYear } from "../state/actions";
import { useApp } from "../state/store";

export const TYPES: Record<LeaveType, { label: string; short?: string; deducts: boolean; spendsOvertime?: boolean }> = {
  vacation: { label: "Vacation", deducts: true },
  comp: { label: "Time off in lieu", short: "In lieu", deducts: false, spendsOvertime: true },
  sick: { label: "Sick leave", short: "Sick", deducts: false },
  remote: { label: "Remote work", short: "Remote", deducts: false },
};
export const TYPE_COLOR: Record<LeaveType, string> = { vacation: "vac", comp: "comp", sick: "sick", remote: "remote" };

export function TypeChip({ type }: { type: LeaveType | "overtime" }) {
  return (
    <span className={`chip ${type}`}>
      <span className="dot" />
      {type === "overtime" ? "Overtime" : TYPES[type].label}
    </span>
  );
}

export function StatusChip({ r }: { r: LeaveOrOvertime }) {
  if (r.status === "pending") return <span className="chip pending">Awaiting approval</span>;
  if (r.status === "approved") return <span className="chip approved">{r.auto ? "Logged" : "Approved"}</span>;
  if (r.status === "rejected") return <span className="chip rejected">Declined</span>;
  return <span className="chip cancelled">Cancelled</span>;
}

const FLAG_TEXT: Record<string, string> = {
  "changed-after-decision": "Changed after it was decided — shown as decided",
  "entry-removed": "Removed by its owner — kept from the approvers’ record",
  "withdrawal-unconfirmed": "Withdrawal awaiting an approver",
  "over-limit": "Would go below the lowest balance allowed — needs an approver",
  "charge-closed": "Booked ahead against a year that is already over — needs an approver",
};
export function Flags({ r }: { r: LeaveOrOvertime }) {
  if (!r.flags.length) return null;
  return <>{r.flags.map((f) => <span key={f} className="flag" title={FLAG_TEXT[f]}>{FLAG_TEXT[f]}</span>)}</>;
}

export function YearPicker() {
  const [s] = useApp();
  const now = new Date().getFullYear();
  const years: number[] = [];
  for (let y = now - 3; y <= now + 2; y++) years.push(y);
  if (!years.includes(s.year)) years.unshift(s.year);
  return (
    <select aria-label="Year" style={{ width: "auto" }} value={s.year} onChange={(e) => setYear(Number(e.target.value))}>
      {years.map((y) => <option key={y} value={y}>{y}</option>)}
    </select>
  );
}

function bookTitle(readOnly: boolean, canBook: boolean): string | undefined {
  if (readOnly) return "You can view this tracker but not book. Ask its owner for Contributor access.";
  if (!canBook) return "Sign in to claude.ai to book.";
  return undefined;
}

/** Says plainly why booking is off, instead of leaving a silently disabled button. */
export function AccessBanner() {
  const [, d] = useApp();
  if (d.readOnly) {
    return (
      <div className="banner" role="status" data-testid="readonly-banner">
        You can view this tracker but not book leave. Ask the tracker’s owner to give you Contributor access in the share menu.
      </div>
    );
  }
  if (d.unbound) {
    return (
      <div className="banner" role="status" data-testid="unbound-banner">
        Someone else has also picked your name on the roster. You can still book; your entries count as soon as an Editor confirms which account is yours.
      </div>
    );
  }
  return null;
}

export function BookButton({ label = "Book leave" }: { label?: string }) {
  const [, d] = useApp();
  return (
    <button className="btn primary" type="button" disabled={!d.canBook} title={bookTitle(d.readOnly, d.canBook)} onClick={() => openModal({ kind: "booking" })}>
      {label}
    </button>
  );
}

export function OvertimeButton({ label = "Log overtime" }: { label?: string }) {
  const [, d] = useApp();
  return (
    <button className="btn" type="button" disabled={!d.canBook} title={bookTitle(d.readOnly, d.canBook)} onClick={() => openModal({ kind: "overtime" })}>
      {label}
    </button>
  );
}

export function Avatar({ uid }: { uid: string | null | undefined }) {
  const [s] = useApp();
  const src = uid ? s.profiles[uid]?.avatarUrl : undefined;
  if (!src) return <span style={{ width: 26, height: 26, borderRadius: "50%", flex: "0 0 auto", background: "var(--surface-3)" }} />;
  return <img src={src} alt="" width={26} height={26} loading="lazy" style={{ borderRadius: "50%", flex: "0 0 auto" }} />;
}

export function Panel({ title, right, children, style }: { title?: ReactNode; right?: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="panel" style={style}>
      {title != null && (
        <div className="hd">
          <h2>{title}</h2>
          <span className="spacer" />
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Legend({ pendingNote, closures = pendingNote === "faded" }: { pendingNote: "faded" | "dashed"; closures?: boolean }) {
  return (
    <div className="legend">
      <span><i style={{ background: "var(--vac)" }} />Vacation</span>
      <span><i style={{ background: "var(--comp)" }} />Time off in lieu</span>
      <span><i style={{ background: "var(--sick)" }} />Sick</span>
      <span><i style={{ background: "var(--remote)" }} />Remote</span>
      {closures && (
        <>
          <span><i style={{ background: "var(--hol)" }} />Office closed</span>
          <span><i style={{ background: "linear-gradient(to bottom,var(--surface-2) 50%,var(--hol) 50%)" }} />Half day off</span>
        </>
      )}
      {pendingNote === "faded" ? (
        <span><i style={{ background: "var(--vac)", opacity: 0.42 }} />Awaiting approval</span>
      ) : (
        <span className="dim">Dashed outline means it still needs an approver.</span>
      )}
    </div>
  );
}
