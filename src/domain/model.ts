import type { Calendar } from "./calendar";
import { countedDays, totalDays } from "./counting";
import { addDays, iso, parseISO, yearOf } from "./dates";
import type {
  Decision, DecisionSnapshot, Entry, ISODate, LeaveEntry, LeaveType, Link, Member, Status,
} from "./types";

/* ====================================================================
   Identity bindings
   A ledger entry counts for a member only if it sits in that member's
   ledger: `ledger/{memberId}` (admins only) or `ledger/{uid}` where uid is
   the member's binding. members.uid (pinned by an admin) wins; otherwise
   an uncontested link claim binds. Link timestamps are never trusted.
   ==================================================================== */

export interface Bindings {
  /** memberId -> uid */
  uidOf: Map<string, string>;
  /** uid -> memberId */
  memberOf: Map<string, string>;
  /** memberIds claimed through links but not yet pinned by an admin */
  unconfirmed: Set<string>;
  /** memberId -> uids that claim it while the claim cannot bind */
  contested: Map<string, string[]>;
}

export function computeBindings(members: readonly Member[], links: readonly Link[]): Bindings {
  const uidOf = new Map<string, string>();
  const memberOf = new Map<string, string>();
  const unconfirmed = new Set<string>();
  const contested = new Map<string, string[]>();
  const pinnedUids = new Set<string>();
  for (const m of members) {
    if (m.uid && !memberOf.has(m.uid)) {
      uidOf.set(m.id, m.uid);
      memberOf.set(m.uid, m.id);
      pinnedUids.add(m.uid);
    }
  }
  const claims = new Map<string, string[]>();
  for (const l of links) {
    if (pinnedUids.has(l.uid)) continue; // a pinned account cannot claim a second member
    const list = claims.get(l.memberId) ?? [];
    list.push(l.uid);
    claims.set(l.memberId, list);
  }
  for (const [memberId, uids] of claims) {
    const m = members.find((x) => x.id === memberId);
    if (!m || m.uid) continue;
    if (uids.length === 1) {
      const uid = uids[0]!;
      uidOf.set(memberId, uid);
      memberOf.set(uid, memberId);
      unconfirmed.add(memberId);
    } else {
      contested.set(memberId, [...uids].sort());
    }
  }
  return { uidOf, memberOf, unconfirmed, contested };
}

/* ====================================================================
   Fingerprints and snapshots
   ==================================================================== */

export function fingerprint(ledgerKey: string, e: Entry | DecisionSnapshot): string {
  const x = e as { type?: string; start?: string; end?: string; halfStart?: boolean; halfEnd?: boolean; halfPeriod?: string | null; date?: string; hours?: number; chargeYear?: number | null };
  const fp = [
    ledgerKey, e.kind, e.memberId,
    x.type ?? "", x.start ?? "", x.end ?? "", x.halfStart ? 1 : 0, x.halfEnd ? 1 : 0, x.halfPeriod ?? "",
    x.date ?? "", x.hours ?? "",
  ].join("|");
  // appended only when set, so every fingerprint written before booking-ahead existed still matches
  return x.chargeYear != null ? `${fp}|cy=${x.chargeYear}` : fp;
}

export function snapshotOf(e: Entry): DecisionSnapshot {
  if (e.kind === "leave") {
    return {
      kind: "leave", memberId: e.memberId, type: e.type, start: e.start, end: e.end, halfStart: e.halfStart, halfEnd: e.halfEnd,
      ...(e.chargeYear != null ? { chargeYear: e.chargeYear } : {}),
    };
  }
  return { kind: "overtime", memberId: e.memberId, date: e.date, hours: e.hours };
}

/* ====================================================================
   Records: what the app shows and counts
   ==================================================================== */

export type Flag =
  | "changed-after-decision"   // the ledger entry no longer matches what was decided
  | "entry-removed"            // decided, but the entry is gone from the ledger
  | "withdrawal-unconfirmed"   // withdrawn after its start without an approver recording it
  | "over-limit"               // would take its year below the lowest balance allowed: needs an approver
  | "charge-closed";           // booked ahead against a year that is already over: needs an approver

interface RecordBase {
  /** `${ledgerKey}/${entryId}` — unique across ledgers */
  uid: string;
  id: string;
  ledgerKey: string;
  memberId: string;
  status: Status;
  /** self-booked and below the threshold, nobody had to decide */
  auto: boolean;
  decision: Decision | null;
  note: string;
  createdBy: string | null;
  createdAt: string | null;
  withdrawnAt: string | null;
  flags: Flag[];
  /** the original ledger entry, when it still exists */
  entry: Entry | null;
}
export interface LeaveRecord extends RecordBase {
  kind: "leave";
  type: LeaveType;
  start: ISODate;
  end: ISODate;
  halfStart: boolean;
  halfEnd: boolean;
  halfPeriod: "am" | "pm" | null;
  /** Booked ahead: days after this year count against it (only an honoured value; see `honouredChargeYear`). */
  chargeYear: number | null;
}
export interface OvertimeRecord extends RecordBase {
  kind: "overtime";
  date: ISODate;
  hours: number;
}
export type LeaveOrOvertime = LeaveRecord | OvertimeRecord;

export interface ModelInput {
  cal: Calendar;
  members: readonly Member[];
  links: readonly Link[];
  /** ledgerKey -> entries */
  ledgers: ReadonlyMap<string, readonly Entry[]>;
  /** ledgerKey -> entryId -> decision */
  decisions: ReadonlyMap<string, ReadonlyMap<string, Decision>>;
  today: ISODate;
  /** archived year -> memberId -> vacation days left at its end (from the archive summaries) */
  yearEnds?: ReadonlyMap<number, Readonly<Record<string, number>>>;
}

export interface Model {
  bindings: Bindings;
  records: LeaveOrOvertime[];
  leave: LeaveRecord[];
  overtime: OvertimeRecord[];
  /** entries in a ledger that does not belong to the member they name */
  ignored: { ledgerKey: string; entryId: string; memberId: string }[];
  /** records whose ending year is already archived (booked late) — excluded from totals */
  late: LeaveOrOvertime[];
  yearEnds: ReadonlyMap<number, Readonly<Record<string, number>>>;
}

/** What `balance` needs from a model. */
export type BalanceModel = Pick<Model, "leave" | "yearEnds">;

export const DEDUCTING: ReadonlySet<LeaveType> = new Set(["vacation"]);
const APPROVAL_TYPES: ReadonlySet<LeaveType> = new Set(["vacation", "comp"]);

function endOf(r: LeaveOrOvertime): ISODate {
  return r.kind === "leave" ? r.end : r.date;
}
function startOf(r: LeaveOrOvertime): ISODate {
  return r.kind === "leave" ? r.start : r.date;
}

/**
 * A stored charge year counts only for vacation, and only one year back from where the
 * booking ends (booking ahead reaches into next year at most). Anything else is ignored.
 */
export function honouredChargeYear(type: LeaveType, end: ISODate, cy: number | null | undefined): number | null {
  return type === "vacation" && cy != null && cy === yearOf(end) - 1 ? cy : null;
}

/** The charge year a new booking gets: vacation ending after the current year is booked ahead. */
export function chargeYearFor(today: ISODate, type: LeaveType, end: ISODate): number | null {
  return type === "vacation" && yearOf(end) === yearOf(today) + 1 ? yearOf(today) : null;
}

/** Last day vacation can be booked up to: 31 December of next year. */
export function lastBookableDay(today: ISODate): ISODate {
  return `${yearOf(today) + 1}-12-31`;
}

/** Which year's vacation balance a counted day of this record comes out of. */
export function chargedYear(r: Pick<LeaveRecord, "type" | "chargeYear">, date: ISODate): number {
  const y = yearOf(date);
  return r.type === "vacation" && r.chargeYear != null && y > r.chargeYear ? r.chargeYear : y;
}

/** The next calendar day after `d` on which a full or half working day exists. */
export function nextWorkingDay(cal: Calendar, d: ISODate): ISODate {
  let x = addDays(parseISO(d), 1);
  for (let i = 0; i < 400; i++) {
    const s = iso(x);
    if (cal.isWorkday(x) && cal.holidayFraction(s) < 1) return s;
    x = addDays(x, 1);
  }
  return iso(x);
}

/** Group leave into contiguous runs: entries touch when nothing but weekends and closures lies between them. */
export function runs<T extends { start: ISODate; end: ISODate }>(cal: Calendar, items: readonly T[]): T[][] {
  const sorted = [...items].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const out: T[][] = [];
  let cur: T[] = [];
  let curEnd = "";
  for (const it of sorted) {
    if (cur.length && it.start <= nextWorkingDay(cal, curEnd)) {
      cur.push(it);
      if (it.end > curEnd) curEnd = it.end;
    } else {
      if (cur.length) out.push(cur);
      cur = [it];
      curEnd = it.end;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

export function needsApprovalAlone(cal: Calendar, e: Pick<LeaveEntry, "type" | "start" | "end" | "halfStart" | "halfEnd">): boolean {
  if (!APPROVAL_TYPES.has(e.type)) return false;
  return totalDays(cal, e) > Number(cal.settings.approvalThreshold || 0);
}

/**
 * Build every record with its effective status. Pure: same input, same output,
 * on every viewer's machine — this is what makes derived auto-approval trustworthy.
 */
export function buildModel(input: ModelInput): Model {
  const { cal, members, links, ledgers, decisions, today } = input;
  const bindings = computeBindings(members, links);
  const memberIds = new Set(members.map((m) => m.id));
  const ignored: Model["ignored"] = [];
  const records: LeaveOrOvertime[] = [];
  const archivedBefore = cal.settings.archivedBefore;

  const seen = new Set<string>();
  for (const [ledgerKey, entries] of ledgers) {
    const decs = decisions.get(ledgerKey);
    for (const e of entries) {
      const owns = memberIds.has(e.memberId) && (ledgerKey === e.memberId || bindings.uidOf.get(e.memberId) === ledgerKey);
      if (!owns) {
        ignored.push({ ledgerKey, entryId: e.id, memberId: e.memberId });
        continue;
      }
      seen.add(`${ledgerKey}/${e.id}`);
      records.push(fromEntry(ledgerKey, e, decs?.get(e.id) ?? null));
    }
  }
  // decided records whose ledger entry has disappeared still count
  for (const [ledgerKey, decs] of decisions) {
    for (const [id, d] of decs) {
      if (seen.has(`${ledgerKey}/${id}`) || !d.snapshot || !memberIds.has(d.snapshot.memberId)) continue;
      const r = fromSnapshot(ledgerKey, id, d);
      if (r) records.push(r);
    }
  }

  // derive status for undecided records
  const undecidedLeave = new Map<string, LeaveRecord[]>();
  for (const r of records) {
    if (r.decision) continue;
    if (r.kind === "overtime") {
      r.status = r.withdrawnAt ? "cancelled" : "pending";
      continue;
    }
    if (!APPROVAL_TYPES.has(r.type)) {
      // sick / remote: logged directly; a withdrawal stands before the start, like any other leave
      r.auto = true;
      if (r.withdrawnAt && today < r.start) r.status = "cancelled";
      else {
        r.status = "approved";
        if (r.withdrawnAt) r.flags.push("withdrawal-unconfirmed");
      }
      continue;
    }
    const list = undecidedLeave.get(r.memberId) ?? [];
    list.push(r);
    undecidedLeave.set(r.memberId, list);
  }
  // threshold applies to contiguous runs of the person's vacation / comp leave
  const threshold = Number(cal.settings.approvalThreshold || 0);
  for (const [memberId, undecided] of undecidedLeave) {
    const all = records.filter(
      (r): r is LeaveRecord => r.kind === "leave" && r.memberId === memberId && APPROVAL_TYPES.has(r.type) &&
        (r.decision ? r.decision.status === "approved" : !r.withdrawnAt),
    );
    for (const run of runs(cal, all)) {
      const days = run.reduce((a, r) => a + totalDays(cal, r), 0);
      for (const r of run) {
        if (r.decision || !undecided.includes(r)) continue;
        r.auto = days <= threshold;
        r.status = r.auto ? "approved" : "pending";
      }
    }
    for (const r of undecided) {
      if (!r.withdrawnAt) continue;
      if (today < r.start || needsApprovalAlone(cal, r)) {
        // upcoming, or never approved in the first place: the withdrawal stands
        r.status = "cancelled";
      } else {
        // self-booked leave withdrawn once it had started: still counts until an approver cancels it
        r.status = "approved";
        r.auto = true;
        r.flags.push("withdrawal-unconfirmed");
      }
    }
  }

  // withdrawals of decided records: honoured before the start (judged on this
  // viewer's clock, never on the stored timestamp); afterwards an approver must record them
  for (const r of records) {
    if (!r.withdrawnAt || !r.entry || !r.decision) continue;
    if (r.decision.status !== "approved") continue;
    if (today < startOf(r)) r.status = "cancelled";
    else r.flags.push("withdrawal-unconfirmed");
  }

  const late: LeaveOrOvertime[] = [];
  const live: LeaveOrOvertime[] = [];
  for (const r of records) {
    if (archivedBefore != null && yearOf(endOf(r)) < archivedBefore) late.push(r);
    else live.push(r);
  }

  // Booking ahead and the minus limit, re-checked here so that a booking written straight into
  // the database can't skip them: such a booking goes to an approver instead of being accepted.
  const yearEnds = input.yearEnds ?? new Map<number, Readonly<Record<string, number>>>();
  const liveLeave = live.filter((r): r is LeaveRecord => r.kind === "leave");
  // A withdrawal after the start isn't confirmed until an approver records it, so those count here too.
  const candidates = liveLeave.filter((r) => !r.decision && r.status === "approved" && r.auto && r.type === "vacation" && r.entry);
  const hold = (r: LeaveRecord, flag: Flag) => {
    r.status = "pending";
    r.auto = false;
    if (!r.flags.includes(flag)) r.flags.push(flag);
  };
  const carryFrom = Number(cal.settings.carryFrom);
  for (const r of liveLeave) {
    if (r.decision || r.chargeYear == null) continue;
    // Not decided yet, but charged to a year already archived: that year's closing balance is
    // fixed, so the days count in their own year and an approver has to look at it.
    if (archivedBefore != null && r.chargeYear < archivedBefore) {
      r.chargeYear = null;
      if (r.status === "approved" && r.auto) hold(r, "charge-closed");
      else if (!r.flags.includes("charge-closed")) r.flags.push("charge-closed");
      continue;
    }
    // A booking ahead is made, and sealed by an approver's page, while its charge year is still
    // running. While carry-over into the next year is entered by hand there is no grace at all
    // (a late charge would be free days); afterwards an honest December booking gets until 31 January.
    const lastDay = r.chargeYear + 1 <= carryFrom ? `${r.chargeYear}-12-31` : `${r.chargeYear + 1}-01-31`;
    if (today > lastDay) {
      if (r.status === "approved" && r.auto) hold(r, "charge-closed");
      else if (!r.flags.includes("charge-closed")) r.flags.push("charge-closed");
    }
  }
  const tmp: BalanceModel = { leave: liveLeave, yearEnds };
  const min = Number(cal.settings.minBalance);
  for (const m of members) {
    const mine = candidates.filter((r) => r.memberId === m.id && r.status === "approved");
    if (!mine.length) continue;
    const charged = new Map<LeaveRecord, Set<number>>();
    let from = Infinity;
    for (const r of mine) {
      const ys = new Set(countedDays(cal, r).map((x) => chargedYear(r, x.date)));
      charged.set(r, ys);
      for (const y of ys) from = Math.min(from, y);
    }
    // every year a minus can reach: the charged years and, through carry-over, the ones after
    const to = lastYearFor(m, liveLeave, from);
    const start = carryStart(cal, m);
    for (let y = from; y <= to && y - from < 10; y++) {
      if (archivedBefore != null && y < archivedBefore) continue;
      if (balance(cal, tmp, m, y).left >= min - 1e-9) continue;
      // Every self-accepted booking that feeds this year waits for an approver, whatever its date,
      // so an extra entry can't push an honest one into the queue while staying accepted itself.
      // A booking feeds year y when it is charged to y, or to an earlier year whose balance carries into y.
      const feeds = (x: number) => x === y || (x < y && x >= start);
      for (const r of mine) if ([...charged.get(r)!].some(feeds)) hold(r, "over-limit");
    }
  }

  live.sort((a, b) => startOf(b).localeCompare(startOf(a)) || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return {
    bindings,
    records: live,
    leave: live.filter((r): r is LeaveRecord => r.kind === "leave"),
    overtime: live.filter((r): r is OvertimeRecord => r.kind === "overtime"),
    ignored,
    late,
    yearEnds,
  };

  function base(ledgerKey: string, id: string, memberId: string, d: Decision | null) {
    return {
      uid: `${ledgerKey}/${id}`, id, ledgerKey, memberId,
      status: (d ? d.status : "pending") as Status,
      auto: !!d && d.by === null && d.grandfathered,
      decision: d,
      flags: [] as Flag[],
    };
  }

  function fromEntry(ledgerKey: string, e: Entry, decision: Decision | null): LeaveOrOvertime {
    let d = decision;
    if (d && d.fp !== fingerprint(ledgerKey, e)) {
      // Changed after it was decided. The decision's snapshot is the record of what was
      // booked — kind, dates and hours included. Never pair edited fields with a decided
      // status (that would let a sealed sick day be rewritten as 24 h of approved overtime).
      const fromSnap = d.snapshot ? fromSnapshot(ledgerKey, e.id, d) : null;
      if (fromSnap) {
        return { ...fromSnap, note: e.note, createdBy: e.createdBy, createdAt: e.createdAt, withdrawnAt: e.withdrawnAt, entry: e, flags: ["changed-after-decision"] };
      }
      d = null; // no usable snapshot: the decision does not apply to this entry
    }
    const b = base(ledgerKey, e.id, e.memberId, d);
    const common = { ...b, note: e.note, createdBy: e.createdBy, createdAt: e.createdAt, withdrawnAt: e.withdrawnAt, entry: e };
    if (decision && !d) common.flags.push("changed-after-decision");
    if (e.kind === "leave") {
      // a decided record is charged as it was decided: the snapshot is what the approver saw
      // (an approver may approve a booking ahead against a year archived since, counted in its own year)
      const snap = d?.snapshot?.kind === "leave" ? d.snapshot : null;
      const cy = snap ? honouredChargeYear(snap.type ?? e.type, snap.end ?? e.end, snap.chargeYear) : honouredChargeYear(e.type, e.end, e.chargeYear);
      return { ...common, kind: "leave", type: e.type, start: e.start, end: e.end, halfStart: e.halfStart, halfEnd: e.halfEnd, halfPeriod: e.halfPeriod, chargeYear: cy };
    }
    return { ...common, kind: "overtime", date: e.date, hours: e.hours };
  }

  function fromSnapshot(ledgerKey: string, id: string, d: Decision): LeaveOrOvertime | null {
    const s = d.snapshot!;
    const b = base(ledgerKey, id, s.memberId, d);
    const common = { ...b, note: "", createdBy: null, createdAt: d.at, withdrawnAt: null, entry: null, flags: ["entry-removed" as Flag] };
    if (s.kind === "leave" && s.start && s.end && s.type) {
      const hp = (s as DecisionSnapshot & { halfPeriod?: "am" | "pm" | null }).halfPeriod ?? null;
      return { ...common, kind: "leave", type: s.type, start: s.start, end: s.end, halfStart: !!s.halfStart, halfEnd: !!s.halfEnd, halfPeriod: hp, chargeYear: honouredChargeYear(s.type, s.end, s.chargeYear) };
    }
    if (s.kind === "overtime" && s.date && typeof s.hours === "number") {
      return { ...common, kind: "overtime", date: s.date, hours: s.hours };
    }
    return null;
  }
}

/* ====================================================================
   Sealing: what an approver's client records so history can't be erased
   ==================================================================== */

export interface SealWrite {
  ledgerKey: string;
  entryId: string;
  decision: Decision;
}

/**
 * Decisions an approver's client should write now: self-booked entries that
 * are approved without anyone deciding (sealed as approved), and upcoming
 * entries their owner withdrew (sealed as cancelled).
 */
export function sealsNeeded(model: Model, now: string, today: ISODate): SealWrite[] {
  const out: SealWrite[] = [];
  for (const r of model.records) {
    const e = r.entry;
    if (!e) continue;
    // a record altered after its decision keeps being judged as it was decided
    const fp = r.decision && r.flags.includes("changed-after-decision") ? r.decision.fp : fingerprint(r.ledgerKey, e);
    const snap = recordSnapshot(r);
    if (r.flags.includes("changed-after-decision") && !r.decision) continue; // an Editor has to look at it
    if (!r.decision && r.status === "approved" && r.auto && !r.flags.includes("withdrawal-unconfirmed")) {
      out.push({ ledgerKey: r.ledgerKey, entryId: r.id, decision: { entryId: r.id, status: "approved", by: null, at: now, note: "", fp, grandfathered: true, snapshot: snap } });
    } else if (e.withdrawnAt && today < startOf(r) && r.status === "cancelled" && (!r.decision || r.decision.status === "approved")) {
      out.push({ ledgerKey: r.ledgerKey, entryId: r.id, decision: { entryId: r.id, status: "cancelled", by: e.withdrawnBy ?? e.memberId, at: now, note: "", fp, grandfathered: true, snapshot: snap } });
    }
  }
  return out;
}

/** The fields a decision records about a record (its effective, as-decided values). */
export function recordSnapshot(r: LeaveOrOvertime): DecisionSnapshot {
  if (r.kind === "leave") {
    return {
      kind: "leave", memberId: r.memberId, type: r.type, start: r.start, end: r.end, halfStart: r.halfStart, halfEnd: r.halfEnd, halfPeriod: r.halfPeriod,
      ...(r.chargeYear != null ? { chargeYear: r.chargeYear } : {}),
    } as DecisionSnapshot;
  }
  return { kind: "overtime", memberId: r.memberId, date: r.date, hours: r.hours };
}

/* ====================================================================
   Balances
   ==================================================================== */

export function entitlement(cal: Calendar, m: Member | null, year: number): number {
  if (!m) return 0;
  const e = m.entitlements[String(year)];
  return Number(e == null ? cal.settings.defaultDays : e) || 0;
}

/** Days an Editor typed in under Team for this year, added on top of the automatic carry-over. */
export function carryover(m: Member | null, year: number): number {
  return Number(m?.carryover[String(year)] ?? 0) || 0;
}

/** First year whose end-of-year balance carries into the next one for this person. */
export function carryStart(cal: Calendar, m: Member): number {
  const added = m.addedAt ? yearOf(m.addedAt) : NaN;
  return Math.max(Number(cal.settings.carryFrom) || 0, Number.isFinite(added) ? added : 0);
}

/** How the previous year ended, carried into `year` automatically (0 before carry-over starts). */
export function autoCarry(cal: Calendar, model: BalanceModel, m: Member | null, year: number, extra: readonly LeaveRecord[] = [], memo?: Map<number, Balance>): number {
  if (!m) return 0;
  const prev = year - 1;
  if (prev < carryStart(cal, m) || year - carryStart(cal, m) > 60) return 0;
  const before = cal.settings.archivedBefore;
  if (before != null && prev < before) return model.yearEnds.get(prev)?.[m.id] ?? 0;
  return (memo ? balanceMemo(cal, model, m, prev, extra, memo) : balance(cal, model, m, prev, extra)).left;
}

/** Balances without extra records, per model, calendar and member: each year is worked out once. */
const cache = new WeakMap<object, { cal: Calendar; byMember: WeakMap<Member, Map<number, Balance>> }>();

export interface Balance {
  ent: number;
  /** automatic carry-over + adjustment */
  carry: number;
  /** the part carried over automatically from the year before */
  auto: number;
  /** the part an Editor typed in */
  adj: number;
  taken: number; pending: number; sick: number; remote: number; left: number;
  /** of taken + pending: vacation in a later year that was booked ahead against this one */
  ahead: number;
}

export function balance(cal: Calendar, model: BalanceModel, member: Member | null, year: number, extra: readonly LeaveRecord[] = []): Balance {
  if (!member) return computeBalance(cal, model, null, year, extra, new Map());
  if (extra.length) return balanceMemo(cal, model, member, year, extra, new Map());
  let c = cache.get(model);
  if (!c || c.cal !== cal) { c = { cal, byMember: new WeakMap() }; cache.set(model, c); }
  let memo = c.byMember.get(member);
  if (!memo) { memo = new Map(); c.byMember.set(member, memo); }
  return balanceMemo(cal, model, member, year, extra, memo);
}

/** `memo` holds this member's balances for this model and these extra records only. */
function balanceMemo(cal: Calendar, model: BalanceModel, member: Member, year: number, extra: readonly LeaveRecord[], memo: Map<number, Balance>): Balance {
  const hit = memo.get(year);
  if (hit) return hit;
  const b = computeBalance(cal, model, member, year, extra, memo);
  memo.set(year, b);
  return b;
}

function computeBalance(cal: Calendar, model: BalanceModel, member: Member | null, year: number, extra: readonly LeaveRecord[], memo: Map<number, Balance>): Balance {
  const ent = entitlement(cal, member, year);
  const adj = carryover(member, year);
  const auto = autoCarry(cal, model, member, year, extra, memo);
  let taken = 0, pending = 0, sick = 0, remote = 0, ahead = 0;
  if (member) {
    for (const r of [...model.leave, ...extra]) {
      if (r.memberId !== member.id || r.status === "rejected" || r.status === "cancelled") continue;
      for (const x of countedDays(cal, r)) {
        if (r.type === "vacation") {
          if (chargedYear(r, x.date) !== year) continue;
          if (r.status === "pending") pending += x.w;
          else taken += x.w;
          if (yearOf(x.date) > year) ahead += x.w;
        } else if (yearOf(x.date) !== year) continue;
        else if (r.type === "sick") sick += x.w;
        else if (r.type === "remote") remote += x.w;
      }
    }
  }
  const carry = auto + adj;
  return { ent, carry, auto, adj, taken, pending, sick, remote, ahead, left: ent + carry - taken - pending };
}

/** The last year a person's minus could reach: their bookings, allowances and adjustments, and at least the year after `from`. */
function lastYearFor(member: Member, leave: readonly LeaveRecord[], from: number): number {
  let to = from + 1;
  for (const r of leave) if (r.memberId === member.id && r.type === "vacation") to = Math.max(to, yearOf(r.end));
  for (const k of [...Object.keys(member.carryover), ...Object.keys(member.entitlements)]) to = Math.max(to, Number(k));
  return to;
}

/** A not-yet-saved booking, shaped like a record so balances can include it. */
export function draftRecord(today: ISODate, d: Pick<LeaveEntry, "memberId" | "type" | "start" | "end" | "halfStart" | "halfEnd" | "halfPeriod">): LeaveRecord {
  return {
    uid: "__draft__", id: "__draft__", ledgerKey: "", memberId: d.memberId, status: "pending", auto: false, decision: null,
    note: "", createdBy: null, createdAt: null, withdrawnAt: null, flags: [], entry: null,
    kind: "leave", type: d.type, start: d.start, end: d.end, halfStart: d.halfStart, halfEnd: d.halfEnd, halfPeriod: d.halfPeriod,
    chargeYear: chargeYearFor(today, d.type, d.end),
  };
}

export interface LimitBreach { year: number; left: number }

/**
 * Years a draft would take below the lowest balance allowed: its own charge year and every
 * later one (carry-over passes a minus forward). Only years the draft makes worse count, so
 * someone already below the limit can still book sick or remote days.
 */
export function limitBreaches(cal: Calendar, model: BalanceModel, member: Member | null, draft: LeaveRecord): LimitBreach[] {
  if (!member || draft.type !== "vacation") return [];
  const days = countedDays(cal, draft);
  if (!days.length) return [];
  const min = Number(cal.settings.minBalance);
  const before = cal.settings.archivedBefore;
  let from = Infinity, to = -Infinity;
  for (const x of days) { const y = chargedYear(draft, x.date); from = Math.min(from, y); to = Math.max(to, y); }
  to = Math.max(to, lastYearFor(member, model.leave, from));
  const out: LimitBreach[] = [];
  const memoNow = new Map<number, Balance>();
  for (let y = from; y <= to && y - from < 10; y++) {
    if (before != null && y < before) continue;
    const was = balance(cal, model, member, y).left;
    const now = balanceMemo(cal, model, member, y, [draft], memoNow).left;
    if (now < min - 1e-9 && now < was - 1e-9) out.push({ year: y, left: now });
  }
  return out;
}

export interface ArchiveCarry {
  /** memberId -> hours approved and hours spent in lieu in that archived year */
  [memberId: string]: { earnedH: number; spentH: number };
}

/**
 * Hours bank up only once approved and run down when time off in lieu is
 * taken. Cumulative: never resets in January. Archived years contribute their
 * recorded totals; live records ending in an archived year are ignored.
 */
export function overtimeBalance(cal: Calendar, model: Model, memberId: string, archive: readonly ArchiveCarry[] = []) {
  let banked = 0, pending = 0, spent = 0;
  for (const a of archive) {
    const c = a[memberId];
    if (c) { banked += c.earnedH; spent += c.spentH; }
  }
  for (const o of model.overtime) {
    if (o.memberId !== memberId) continue;
    if (o.status === "pending") pending += o.hours;
    else if (o.status === "approved") banked += o.hours;
  }
  for (const r of model.leave) {
    if (r.memberId !== memberId || r.type !== "comp" || r.status === "rejected" || r.status === "cancelled") continue;
    spent += totalDays(cal, r) * cal.hoursPerDay();
  }
  return { banked, pending, spent, left: banked - spent };
}

export function overtimeInYear(cal: Calendar, model: Model, memberId: string, year: number) {
  let approved = 0, pending = 0, spent = 0;
  for (const o of model.overtime) {
    if (o.memberId !== memberId || yearOf(o.date) !== year) continue;
    if (o.status === "pending") pending += o.hours;
    else if (o.status === "approved") approved += o.hours;
  }
  for (const r of model.leave) {
    if (r.memberId !== memberId || r.type !== "comp" || r.status === "rejected" || r.status === "cancelled") continue;
    spent += countedDays(cal, r).reduce((a, x) => a + (yearOf(x.date) === year ? x.w : 0), 0) * cal.hoursPerDay();
  }
  return { approved, pending, spent };
}

/** Leave records that keep someone away on a date (not declined or cancelled, and a working day for them). */
export function absencesOn(cal: Calendar, records: readonly LeaveRecord[], date: ISODate): LeaveRecord[] {
  return records.filter((r) => r.status !== "rejected" && r.status !== "cancelled" && r.start <= date && r.end >= date &&
    countedDays(cal, r).some((x) => x.date === date));
}

/** Total days of the contiguous vacation/comp run a draft would join — what the approval threshold judges. */
export function runDaysWith(cal: Calendar, model: Model, draft: Pick<LeaveEntry, "memberId" | "type" | "start" | "end" | "halfStart" | "halfEnd">): number {
  if (!APPROVAL_TYPES.has(draft.type)) return totalDays(cal, draft);
  const mine = model.leave.filter((r) => r.memberId === draft.memberId && APPROVAL_TYPES.has(r.type) && r.status !== "rejected" && r.status !== "cancelled");
  const probe = { ...draft, id: "__draft__" } as typeof draft & { id: string };
  for (const run of runs(cal, [...mine, probe] as (typeof probe)[])) {
    if (run.includes(probe)) return run.reduce((a, r) => a + totalDays(cal, r), 0);
  }
  return totalDays(cal, draft);
}
