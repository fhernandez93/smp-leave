/**
 * Everything read from the database is other people's input. These parsers
 * turn raw document bodies into typed values, dropping anything malformed
 * (and `null` placeholders left behind by archiving).
 */
import { DEFAULT_SETTINGS, HOLIDAY_DEFS } from "../domain/calendar";
import { isISODate } from "../domain/dates";
import type {
  CustomHoliday, Decision, DecisionSnapshot, Entry, Joiner, LeaveType, Link, Member, Settings, YearEndOverride,
} from "../domain/types";
import { LEAVE_TYPES } from "../domain/types";

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v.slice(0, 200) : null);
const finite = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown): boolean => v === true;
/** A plausible calendar year, or null. */
export const yearOrNull = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 1900 && (v as number) <= 9999 ? (v as number) : null);
/** The lowest balance allowed: never positive (a missing sign means minus), never below −366. */
export function parseMinBalance(v: unknown): number {
  const n = finite(v, DEFAULT_SETTINGS.minBalance);
  return Math.max(-366, -Math.abs(n));
}

function numMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    if (/^\d{4}$/.test(k) && typeof x === "number" && Number.isFinite(x)) out[k] = x;
  }
  return out;
}

const HOLIDAY_KEYS = new Set(HOLIDAY_DEFS.map((d) => d.key));

export function parseSettings(raw: Raw | undefined): { settings: Settings; exists: boolean } {
  if (!isObj(raw)) return { settings: { ...DEFAULT_SETTINGS, holidays: [...DEFAULT_SETTINGS.holidays] }, exists: false };
  const workdays = Array.isArray(raw.workdays)
    ? [...new Set(raw.workdays.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))]
    : [];
  const holidays = Array.isArray(raw.holidays) ? raw.holidays.filter((k): k is string => typeof k === "string" && HOLIDAY_KEYS.has(k)) : [...DEFAULT_SETTINGS.holidays];
  const customHolidays: CustomHoliday[] = Array.isArray(raw.customHolidays)
    ? raw.customHolidays.filter(isObj).filter((c) => isISODate(c.date)).map((c) => ({ date: c.date as string, name: str(c.name, 120), half: bool(c.half) }))
    : [];
  const yearEnd: Record<string, YearEndOverride> = {};
  if (isObj(raw.yearEnd)) {
    for (const [y, v] of Object.entries(raw.yearEnd)) {
      if (!/^\d{4}$/.test(y) || !isObj(v)) continue;
      const o: YearEndOverride = {};
      for (const k of ["dec24", "dec31"] as const) if (v[k] === 0 || v[k] === 0.5 || v[k] === 1) o[k] = v[k] as number;
      yearEnd[y] = o;
    }
  }
  const archivedBefore = Number.isInteger(raw.archivedBefore) ? (raw.archivedBefore as number) : null;
  return {
    exists: true,
    settings: {
      teamName: str(raw.teamName, 120) || DEFAULT_SETTINGS.teamName,
      defaultDays: finite(raw.defaultDays, DEFAULT_SETTINGS.defaultDays),
      workdays: workdays.length ? workdays : [...DEFAULT_SETTINGS.workdays],
      approvalThreshold: finite(raw.approvalThreshold, DEFAULT_SETTINGS.approvalThreshold),
      hoursPerDay: finite(raw.hoursPerDay, DEFAULT_SETTINGS.hoursPerDay) || DEFAULT_SETTINGS.hoursPerDay,
      holidays,
      customHolidays,
      yearEnd,
      created: strOrNull(raw.created),
      holidayVersion: finite(raw.holidayVersion, 0),
      archivedBefore,
      minBalance: parseMinBalance(raw.minBalance),
      carryFrom: yearOrNull(raw.carryFrom) ?? DEFAULT_SETTINGS.carryFrom,
    },
  };
}

export function parseMember(id: string, raw: Raw | undefined): Member | null {
  if (!isObj(raw)) return null;
  return {
    id,
    name: str(raw.name, 120),
    nameHint: str(raw.nameHint, 120),
    uid: strOrNull(raw.uid),
    role: raw.role === "manager" ? "manager" : "member",
    entitlements: numMap(raw.entitlements),
    carryover: numMap(raw.carryover),
    archived: bool(raw.archived),
    keepUnresolved: bool(raw.keepUnresolved),
    source: str(raw.source, 40) || "manual",
    addedAt: strOrNull(raw.addedAt),
    leftAt: strOrNull(raw.leftAt),
  };
}

export function parseLink(uid: string, raw: Raw | undefined): Link | null {
  if (!isObj(raw) || typeof raw.memberId !== "string" || !raw.memberId) return null;
  return { uid, memberId: raw.memberId, at: strOrNull(raw.at) };
}

/** The asker's id is the document id; any `uid` in the body is ignored. */
export function parseJoiner(uid: string, raw: Raw | undefined): Joiner | null {
  if (!isObj(raw)) return null;
  return { uid, nameHint: str(raw.nameHint, 120), requestedAt: strOrNull(raw.requestedAt) };
}

export function parseEntry(id: string, raw: unknown): Entry | null {
  if (!isObj(raw) || typeof raw.memberId !== "string" || !raw.memberId) return null;
  const base = {
    id,
    memberId: raw.memberId,
    note: str(raw.note),
    createdBy: strOrNull(raw.createdBy),
    createdAt: strOrNull(raw.createdAt),
    withdrawnAt: strOrNull(raw.withdrawnAt),
    withdrawnBy: strOrNull(raw.withdrawnBy),
  };
  if (raw.kind === "overtime") {
    const hours = raw.hours;
    if (!isISODate(raw.date) || typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours > 24) return null;
    return { ...base, kind: "overtime", date: raw.date, hours };
  }
  if (raw.kind !== "leave") return null;
  if (!LEAVE_TYPES.includes(raw.type as LeaveType)) return null;
  if (!isISODate(raw.start) || !isISODate(raw.end) || raw.end < raw.start) return null;
  const halfPeriod = raw.halfPeriod === "am" || raw.halfPeriod === "pm" ? raw.halfPeriod : null;
  return {
    ...base, kind: "leave", type: raw.type as LeaveType, start: raw.start, end: raw.end,
    halfStart: bool(raw.halfStart), halfEnd: bool(raw.halfEnd), halfPeriod,
    ...(yearOrNull(raw.chargeYear) != null ? { chargeYear: yearOrNull(raw.chargeYear) } : {}),
  };
}

/** `ledger/{key}` body → entries (null placeholders and malformed entries dropped). */
export function parseLedger(raw: Raw | undefined): Entry[] {
  if (!isObj(raw) || !isObj(raw.entries)) return [];
  const out: Entry[] = [];
  for (const [id, e] of Object.entries(raw.entries)) {
    const p = parseEntry(id, e);
    if (p) out.push(p);
  }
  return out;
}

function parseSnapshot(raw: unknown): DecisionSnapshot | null {
  if (!isObj(raw) || typeof raw.memberId !== "string") return null;
  if (raw.kind === "leave") {
    if (!LEAVE_TYPES.includes(raw.type as LeaveType) || !isISODate(raw.start) || !isISODate(raw.end) || raw.end < raw.start) return null;
    const s: DecisionSnapshot & { halfPeriod?: "am" | "pm" | null } = {
      kind: "leave", memberId: raw.memberId, type: raw.type as LeaveType, start: raw.start, end: raw.end,
      halfStart: bool(raw.halfStart), halfEnd: bool(raw.halfEnd),
    };
    if (raw.halfPeriod === "am" || raw.halfPeriod === "pm") s.halfPeriod = raw.halfPeriod;
    const cy = yearOrNull(raw.chargeYear);
    if (cy != null) s.chargeYear = cy;
    return s;
  }
  if (raw.kind === "overtime") {
    if (!isISODate(raw.date) || typeof raw.hours !== "number" || !Number.isFinite(raw.hours)) return null;
    return { kind: "overtime", memberId: raw.memberId, date: raw.date, hours: raw.hours };
  }
  return null;
}

export function parseDecision(entryId: string, raw: unknown): Decision | null {
  if (!isObj(raw)) return null;
  if (raw.status !== "approved" && raw.status !== "rejected" && raw.status !== "cancelled") return null;
  return {
    entryId,
    status: raw.status,
    by: strOrNull(raw.by),
    at: strOrNull(raw.at),
    note: str(raw.note),
    fp: str(raw.fp, 600),
    grandfathered: bool(raw.grandfathered),
    snapshot: parseSnapshot(raw.snapshot),
  };
}

/** `decisions/{ledgerKey}` body → entryId → decision. */
export function parseDecisions(raw: Raw | undefined): Map<string, Decision> {
  const out = new Map<string, Decision>();
  if (!isObj(raw) || !isObj(raw.items)) return out;
  for (const [id, d] of Object.entries(raw.items)) {
    const p = parseDecision(id, d);
    if (p) out.set(id, p);
  }
  return out;
}

export interface ArchiveSummary {
  year: number;
  hoursPerDay: number;
  carry: Record<string, { earnedH: number; spentH: number }>;
  /** memberId -> vacation days left at the end of that year (carried into the next) */
  vacLeft: Record<string, number>;
  complete: boolean;
}

export function parseArchiveSummary(id: string, raw: Raw | undefined): ArchiveSummary | null {
  if (!isObj(raw) || !/^\d{4}$/.test(id)) return null;
  const carry: ArchiveSummary["carry"] = {};
  if (isObj(raw.carry)) {
    for (const [m, v] of Object.entries(raw.carry)) {
      if (isObj(v)) carry[m] = { earnedH: finite(v.earnedH, 0), spentH: finite(v.spentH, 0) };
    }
  }
  const vacLeft: Record<string, number> = {};
  if (isObj(raw.vacLeft)) {
    for (const [m, v] of Object.entries(raw.vacLeft)) if (typeof v === "number" && Number.isFinite(v)) vacLeft[m] = v;
  }
  return { year: Number(id), hoursPerDay: finite(raw.hoursPerDay, DEFAULT_SETTINGS.hoursPerDay), carry, vacLeft, complete: bool(raw.complete) };
}
