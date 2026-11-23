/** Shared data shapes. Everything stored in the artifact's database is
 *  described here; anything read back is validated by `platform/parse.ts`
 *  before it reaches these types, because stored data is other people's input. */

export type ISODate = string; // yyyy-mm-dd, always UTC calendar dates
export type ISOTime = string; // full ISO timestamp

export type LeaveType = "vacation" | "comp" | "sick" | "remote";
export const LEAVE_TYPES: readonly LeaveType[] = ["vacation", "comp", "sick", "remote"];

export type DecisionStatus = "approved" | "rejected" | "cancelled";
export type Status = "pending" | "approved" | "rejected" | "cancelled";

export type HalfPeriod = "am" | "pm";

export interface CustomHoliday {
  date: ISODate;
  name: string;
  half: boolean;
}

export interface YearEndOverride {
  dec24?: number;
  dec31?: number;
}

export interface Settings {
  teamName: string;
  defaultDays: number;
  /** JS getUTCDay() numbers: 0 = Sunday, 1 = Monday … */
  workdays: number[];
  /** Vacation / time off in lieu longer than this many working days needs an approver. */
  approvalThreshold: number;
  hoursPerDay: number;
  holidays: string[];
  customHolidays: CustomHoliday[];
  yearEnd: Record<string, YearEndOverride>;
  created: ISOTime | null;
  holidayVersion: number;
  /** Ledger entries ending before 1 January of this year live in archive docs. */
  archivedBefore: number | null;
  /** Lowest vacation balance a booking may leave (≤ 0, e.g. −10). */
  minBalance: number;
  /** First year whose end-of-year vacation balance carries into the next year automatically. */
  carryFrom: number;
}

export type Role = "member" | "manager";

export interface Member {
  id: string;
  name: string;
  nameHint: string;
  uid: string | null;
  role: Role;
  entitlements: Record<string, number>;
  carryover: Record<string, number>;
  archived: boolean;
  keepUnresolved: boolean;
  source: string;
  addedAt: ISOTime | null;
  leftAt: ISOTime | null;
}

interface EntryBase {
  id: string;
  memberId: string;
  note: string;
  createdBy: string | null;
  createdAt: ISOTime | null;
  /** Set when the person themself withdrew the entry. */
  withdrawnAt: ISOTime | null;
  withdrawnBy: string | null;
}

export interface LeaveEntry extends EntryBase {
  kind: "leave";
  type: LeaveType;
  start: ISODate;
  end: ISODate;
  halfStart: boolean;
  halfEnd: boolean;
  halfPeriod: HalfPeriod | null;
  /**
   * Vacation booked ahead: days falling after this year count against it. Set when
   * the booking was made in this year and ends in the next one; absent otherwise.
   */
  chargeYear?: number | null;
}

export interface OvertimeEntry extends EntryBase {
  kind: "overtime";
  date: ISODate;
  hours: number;
}

export type Entry = LeaveEntry | OvertimeEntry;

/** The fields of an entry an approver actually decided on. */
export interface DecisionSnapshot {
  kind: "leave" | "overtime";
  memberId: string;
  type?: LeaveType;
  start?: ISODate;
  end?: ISODate;
  date?: ISODate;
  hours?: number;
  halfStart?: boolean;
  halfEnd?: boolean;
  halfPeriod?: HalfPeriod | null;
  chargeYear?: number | null;
}

export interface Decision {
  entryId: string;
  status: DecisionStatus;
  /** memberId of the approver */
  by: string | null;
  at: ISOTime | null;
  note: string;
  /** Fingerprint of the entry at decision time; a decision only applies while it matches. */
  fp: string;
  /** true when written automatically to keep an entry approved after a threshold change */
  grandfathered: boolean;
  snapshot: DecisionSnapshot | null;
}

export interface Link {
  uid: string;
  memberId: string;
  at: ISOTime | null;
}

export interface Joiner {
  uid: string;
  nameHint: string;
  requestedAt: ISOTime | null;
}

/** Where an entry lives: `ledger/{key}` (key = owner's Claude id, or the memberId for unlinked people). */
export interface LedgerDoc {
  key: string;
  entries: Entry[];
}
