/**
 * v1 → v2 data migration (and the v2 → v1 back-port used for rollback).
 * Pure functions: they take documents and return documents to write.
 *
 * v1: requests/{id}, overtime/{id} with status fields written by anyone.
 * v2: ledger/{key}.entries[id] (the booking), decisions/{key}.items[id] (the decision).
 * The v1 document id is kept as the v2 entry id, so running the migration
 * again is idempotent and picks up bookings made in stale v1 tabs.
 */
import { fingerprint, snapshotOf } from "../domain/model";
import type { Decision, Entry, LeaveType, Member } from "../domain/types";
import { LEAVE_TYPES } from "../domain/types";
import { isISODate } from "../domain/dates";

type Raw = Record<string, unknown>;

export interface V1Doc { id: string; data: Raw }

export interface V2Writes {
  /** ledgerKey -> entryId -> entry body */
  ledgers: Record<string, Record<string, Raw>>;
  /** ledgerKey -> entryId -> decision body */
  decisions: Record<string, Record<string, Raw>>;
  skipped: { id: string; reason: string }[];
}

const s = (v: unknown) => (typeof v === "string" ? v : "");
const sn = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Where an entry for this member lives: their pinned Claude id, else the memberId (Editor-only ledger). */
export function ledgerKeyFor(member: Pick<Member, "id" | "uid">): string {
  return member.uid || member.id;
}

export function entryBody(e: Entry): Raw {
  const common = {
    kind: e.kind, memberId: e.memberId, note: e.note, createdBy: e.createdBy, createdAt: e.createdAt,
    withdrawnAt: e.withdrawnAt, withdrawnBy: e.withdrawnBy,
  };
  if (e.kind === "leave") {
    return { ...common, type: e.type, start: e.start, end: e.end, halfStart: e.halfStart, halfEnd: e.halfEnd, halfPeriod: e.halfPeriod };
  }
  return { ...common, date: e.date, hours: e.hours };
}

export function decisionBody(d: Decision): Raw {
  return { status: d.status, by: d.by, at: d.at, note: d.note, fp: d.fp, grandfathered: d.grandfathered, snapshot: d.snapshot ? { ...d.snapshot } : null };
}

export function migrateV1(
  members: readonly Pick<Member, "id" | "uid">[],
  requests: readonly V1Doc[],
  overtime: readonly V1Doc[],
  now: string,
): V2Writes {
  const out: V2Writes = { ledgers: {}, decisions: {}, skipped: [] };
  const byId = new Map(members.map((m) => [m.id, m]));

  const put = (key: string, e: Entry, d: Decision | null) => {
    (out.ledgers[key] ??= {})[e.id] = entryBody(e);
    if (d) (out.decisions[key] ??= {})[e.id] = decisionBody(d);
  };

  for (const { id, data: r } of requests) {
    const m = byId.get(s(r.memberId));
    if (!m) { out.skipped.push({ id, reason: "unknown member" }); continue; }
    if (!LEAVE_TYPES.includes(r.type as LeaveType) || !isISODate(r.start) || !isISODate(r.end) || (r.end as string) < (r.start as string)) {
      out.skipped.push({ id, reason: "malformed request" }); continue;
    }
    const key = ledgerKeyFor(m);
    const e: Entry = {
      id, kind: "leave", memberId: m.id, type: r.type as LeaveType, start: r.start as string, end: r.end as string,
      halfStart: r.halfStart === true, halfEnd: r.halfEnd === true,
      halfPeriod: r.halfPeriod === "am" || r.halfPeriod === "pm" ? r.halfPeriod : null,
      note: s(r.note).slice(0, 500), createdBy: sn(r.createdBy), createdAt: sn(r.createdAt), withdrawnAt: null, withdrawnBy: null,
    };
    put(key, e, decisionFromV1(key, e, r, now));
  }

  for (const { id, data: o } of overtime) {
    const m = byId.get(s(o.memberId));
    const hours = o.hours;
    if (!m) { out.skipped.push({ id, reason: "unknown member" }); continue; }
    if (!isISODate(o.date) || typeof hours !== "number" || !(hours > 0)) { out.skipped.push({ id, reason: "malformed overtime" }); continue; }
    const key = ledgerKeyFor(m);
    const e: Entry = {
      id, kind: "overtime", memberId: m.id, date: o.date as string, hours,
      note: s(o.note).slice(0, 500), createdBy: sn(o.createdBy), createdAt: sn(o.createdAt), withdrawnAt: null, withdrawnBy: null,
    };
    put(key, e, decisionFromV1(key, e, o, now));
  }
  return out;
}

function decisionFromV1(key: string, e: Entry, r: Raw, now: string): Decision | null {
  const status = r.status;
  const snap = { ...snapshotOf(e), ...(e.kind === "leave" ? { halfPeriod: e.halfPeriod } : {}) };
  const base = { entryId: e.id, fp: fingerprint(key, e), snapshot: snap, note: s(r.decisionNote).slice(0, 500) };
  if (status === "approved") {
    const auto = r.autoApproved === true;
    // v1 auto-approved bookings are sealed the same way v2 seals them
    return { ...base, status: "approved", by: auto ? null : sn(r.decidedBy), at: auto ? now : sn(r.decidedAt) ?? now, grandfathered: auto };
  }
  if (status === "rejected") return { ...base, status: "rejected", by: sn(r.decidedBy), at: sn(r.decidedAt) ?? now, grandfathered: false };
  if (status === "cancelled") return { ...base, status: "cancelled", by: sn(r.cancelledBy) ?? sn(r.decidedBy), at: sn(r.cancelledAt) ?? now, grandfathered: false };
  return null; // pending stays undecided
}

/**
 * v2 → v1 back-port for rollback: given resolved records, produce v1
 * `requests/{id}` and `overtime/{id}` bodies so the v1 page shows everything
 * booked under v2.
 */
export function backportToV1(records: readonly {
  id: string; kind: "leave" | "overtime"; memberId: string; status: string; auto: boolean; note: string;
  createdBy: string | null; createdAt: string | null; decision: Decision | null;
  type?: string; start?: string; end?: string; halfStart?: boolean; halfEnd?: boolean; halfPeriod?: string | null;
  date?: string; hours?: number;
}[]): { requests: Record<string, Raw>; overtime: Record<string, Raw> } {
  const requests: Record<string, Raw> = {};
  const overtime: Record<string, Raw> = {};
  for (const r of records) {
    const decided = r.decision && !r.auto ? r.decision : null;
    const common = {
      memberId: r.memberId, note: r.note, status: r.status, createdBy: r.createdBy, createdAt: r.createdAt,
      decidedBy: decided?.by ?? null, decidedAt: decided?.at ?? null, decisionNote: decided?.note ?? "",
    };
    if (r.kind === "leave") {
      requests[r.id] = {
        ...common, type: r.type, start: r.start, end: r.end, halfStart: !!r.halfStart, halfEnd: !!r.halfEnd,
        halfPeriod: r.halfPeriod ?? null, autoApproved: r.auto,
        ...(r.status === "cancelled" ? { cancelledBy: r.decision?.by ?? r.memberId, cancelledAt: r.decision?.at ?? null } : {}),
      };
    } else {
      overtime[r.id] = { ...common, date: r.date, hours: r.hours };
    }
  }
  return { requests, overtime };
}
