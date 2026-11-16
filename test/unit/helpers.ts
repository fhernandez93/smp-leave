import { Calendar, DEFAULT_SETTINGS } from "../../src/domain/calendar";
import type { Decision, Entry, LeaveEntry, Link, Member, OvertimeEntry, Settings } from "../../src/domain/types";
import { buildModel, type Model } from "../../src/domain/model";

export const cal = (over: Partial<Settings> = {}) => new Calendar({ ...DEFAULT_SETTINGS, ...over });

export function member(id: string, over: Partial<Member> = {}): Member {
  return {
    id, name: id.toUpperCase(), nameHint: "", uid: null, role: "member", entitlements: {}, carryover: {},
    archived: false, keepUnresolved: false, source: "manual", addedAt: "2026-01-01T00:00:00Z", leftAt: null, ...over,
  };
}

export function leave(id: string, memberId: string, start: string, end: string, over: Partial<LeaveEntry> = {}): LeaveEntry {
  return {
    id, kind: "leave", memberId, type: "vacation", start, end, halfStart: false, halfEnd: false, halfPeriod: null,
    note: "", createdBy: memberId, createdAt: "2026-01-05T09:00:00Z", withdrawnAt: null, withdrawnBy: null, ...over,
  };
}

export function ot(id: string, memberId: string, date: string, hours: number, over: Partial<OvertimeEntry> = {}): OvertimeEntry {
  return { id, kind: "overtime", memberId, date, hours, note: "", createdBy: memberId, createdAt: "2026-01-05T09:00:00Z", withdrawnAt: null, withdrawnBy: null, ...over };
}

export interface World {
  settings?: Partial<Settings>;
  members: Member[];
  links?: Link[];
  ledgers: Record<string, Entry[]>;
  decisions?: Record<string, Record<string, Decision>>;
  today?: string;
}

export function model(w: World): { m: Model; c: Calendar } {
  const c = cal(w.settings);
  const m = buildModel({
    cal: c,
    members: w.members,
    links: w.links ?? [],
    ledgers: new Map(Object.entries(w.ledgers)),
    decisions: new Map(Object.entries(w.decisions ?? {}).map(([k, v]) => [k, new Map(Object.entries(v))])),
    today: w.today ?? "2026-03-01",
  });
  return { m, c };
}
