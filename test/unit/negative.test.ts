import { describe, expect, it } from "vitest";
import {
  autoCarry, balance, draftRecord, fingerprint, limitBreaches, recordSnapshot, sealsNeeded, snapshotOf, type LeaveRecord,
} from "../../src/domain/model";
import { entryBody } from "../../src/platform/migrate";
import { parseDecisions, parseLedger, parseSettings } from "../../src/platform/parse";
import type { Decision, Entry, LeaveEntry } from "../../src/domain/types";
import { leave, member, model } from "./helpers";

const alice = member("m_alice", { uid: "u_alice" });
const rec = (m: { leave: LeaveRecord[] }, id: string) => m.leave.find((r) => r.id === id)!;
function decided(key: string, e: Entry, status: Decision["status"] = "approved", over: Partial<Decision> = {}): Decision {
  return { entryId: e.id, status, by: "m_boss", at: "2026-01-06T00:00:00Z", note: "", fp: fingerprint(key, e), grandfathered: false, snapshot: snapshotOf(e), ...over };
}
const draft = (start: string, end: string, over: Partial<LeaveEntry> = {}) =>
  ({ memberId: "m_alice", type: "vacation" as const, start, end, halfStart: false, halfEnd: false, halfPeriod: null, ...over });

describe("settings", () => {
  it("defaults the minus limit to -10 and carry-over to start with 2027", () => {
    const { settings } = parseSettings({ teamName: "T" });
    expect(settings.minBalance).toBe(-10);
    expect(settings.carryFrom).toBe(2027);
  });
  it("never lets the limit be positive or unbounded", () => {
    expect(parseSettings({ minBalance: 5 }).settings.minBalance).toBe(-5);
    expect(parseSettings({ minBalance: -3 }).settings.minBalance).toBe(-3);
    expect(parseSettings({ minBalance: "x" }).settings.minBalance).toBe(-10);
    expect(parseSettings({ minBalance: -1e9 }).settings.minBalance).toBe(-366);
    expect(parseSettings({ carryFrom: 2030 }).settings.carryFrom).toBe(2030);
    expect(parseSettings({ carryFrom: "2030" }).settings.carryFrom).toBe(2027);
  });
});

describe("charge year storage", () => {
  it("round-trips through the ledger and decisions, and is omitted when unset", () => {
    const e = leave("r1", "m_alice", "2027-01-04", "2027-01-05", { chargeYear: 2026 });
    expect(entryBody(e).chargeYear).toBe(2026);
    expect("chargeYear" in entryBody(leave("r2", "m_alice", "2026-03-02", "2026-03-02"))).toBe(false);
    const [back] = parseLedger({ entries: { r1: entryBody(e) } });
    expect((back as LeaveEntry).chargeYear).toBe(2026);
    const [junk] = parseLedger({ entries: { r1: { ...entryBody(e), chargeYear: "2026" } } });
    expect((junk as LeaveEntry).chargeYear).toBeUndefined();
    const d = parseDecisions({ items: { r1: { status: "approved", fp: "x", snapshot: snapshotOf(e) } } });
    expect(d.get("r1")!.snapshot!.chargeYear).toBe(2026);
  });

  it("leaves every fingerprint written before this change unchanged", () => {
    expect(fingerprint("u_alice", leave("r1", "m_alice", "2026-03-02", "2026-03-02"))).toBe("u_alice|leave|m_alice|vacation|2026-03-02|2026-03-02|0|0|||");
    expect(fingerprint("u_alice", leave("r1", "m_alice", "2027-01-04", "2027-01-04", { chargeYear: 2026 }))).toBe("u_alice|leave|m_alice|vacation|2027-01-04|2027-01-04|0|0||||cy=2026");
  });
});

describe("booking ahead", () => {
  it("counts next year's days booked ahead against this year", () => {
    const { m, c } = model({ members: [alice], today: "2026-11-23", ledgers: { u_alice: [leave("j", "m_alice", "2027-01-11", "2027-01-12", { chargeYear: 2026 })] } });
    expect(rec(m, "j").chargeYear).toBe(2026);
    expect(balance(c, m, alice, 2026)).toMatchObject({ taken: 2, ahead: 2, left: 23 });
    expect(balance(c, m, alice, 2027)).toMatchObject({ taken: 0, left: 25 });
  });

  it("puts a whole Dec–Jan run on this year, and splits one without a charge year as before", () => {
    const run = (over: Partial<LeaveEntry>) => model({ members: [alice], today: "2026-11-23", ledgers: { u_alice: [leave("x", "m_alice", "2026-12-14", "2027-01-15", over)] } });
    const used = (w: ReturnType<typeof run>, y: number) => { const b = balance(w.c, w.m, alice, y); return b.taken + b.pending; };
    const a = run({ chargeYear: 2026 });
    const b = run({});
    expect(used(a, 2027)).toBe(0);
    expect(used(b, 2026)).toBeGreaterThan(0);
    expect(used(b, 2027)).toBeGreaterThan(0);
    expect(used(a, 2026)).toBe(used(b, 2026) + used(b, 2027));
  });

  it("ignores a charge year more than one year back, or on anything but vacation", () => {
    const { m, c } = model({
      members: [alice], today: "2026-11-23",
      ledgers: { u_alice: [leave("f", "m_alice", "2027-01-11", "2027-01-11", { chargeYear: 2025 }), leave("s", "m_alice", "2027-01-12", "2027-01-12", { type: "sick", chargeYear: 2026 })] },
    });
    expect(rec(m, "f").chargeYear).toBeNull();
    expect(rec(m, "s").chargeYear).toBeNull();
    expect(balance(c, m, alice, 2027)).toMatchObject({ taken: 1, sick: 1 });
  });

  it("a draft gets a charge year only when it ends in next year", () => {
    expect(draftRecord("2026-11-23", draft("2027-01-04", "2027-01-05")).chargeYear).toBe(2026);
    expect(draftRecord("2026-11-23", draft("2028-01-04", "2028-01-05")).chargeYear).toBeNull();
    expect(draftRecord("2026-11-23", draft("2026-12-01", "2026-12-02")).chargeYear).toBeNull();
    expect(draftRecord("2026-11-23", draft("2027-01-04", "2027-01-05", { type: "sick" })).chargeYear).toBeNull();
  });
});

describe("carry-over", () => {
  const twoYears = (over = {}) => member("m_alice", { uid: "u_alice", entitlements: { "2027": 25, "2028": 25 }, ...over });
  it("carries nothing into 2027, then plus or minus automatically, with the adjustment on top", () => {
    const a = twoYears({ carryover: { "2028": 1 } });
    const { m, c } = model({
      members: [a], today: "2027-03-01",
      ledgers: { u_alice: [leave("y26", "m_alice", "2026-03-02", "2026-03-06"), leave("y27", "m_alice", "2027-03-01", "2027-03-02")] },
      decisions: {},
    });
    expect(autoCarry(c, m, a, 2027)).toBe(0);
    expect(balance(c, m, a, 2027).left).toBe(23);
    expect(balance(c, m, a, 2028)).toMatchObject({ auto: 23, adj: 1, carry: 24, left: 49 });
  });

  it("carries a minus forward", () => {
    const a = twoYears({ entitlements: { "2027": 0, "2028": 25 } });
    const { m, c } = model({ members: [a], today: "2027-03-01", ledgers: { u_alice: [leave("y27", "m_alice", "2027-03-01", "2027-03-02")] } });
    expect(balance(c, m, a, 2028)).toMatchObject({ auto: -2, left: 23 });
  });

  it("starts with the year someone joined, and reads archived years from the archive summary", () => {
    const late = twoYears({ addedAt: "2028-02-01T00:00:00Z" });
    const x = model({ members: [late], today: "2028-03-01", ledgers: {} });
    expect(autoCarry(x.c, x.m, late, 2028)).toBe(0);
    const a = twoYears();
    const { c, m } = model({ members: [a], today: "2029-03-01", settings: { archivedBefore: 2028 }, ledgers: {} });
    const withEnds = { ...m, yearEnds: new Map([[2027, { m_alice: -3 }]]) };
    expect(autoCarry(c, withEnds, a, 2028)).toBe(-3);
    expect(autoCarry(c, m, a, 2028)).toBe(0); // an older archive without the figure carries nothing
  });
});

describe("the minus limit", () => {
  const poor = member("m_alice", { uid: "u_alice", entitlements: { "2026": 5, "2027": 25 } });
  it("allows going down to exactly the limit and refuses half a day more", () => {
    const { m, c } = model({ members: [poor], today: "2026-03-01", ledgers: {} });
    // 2–20 March 2026: 15 working days → 5 - 15 = -10
    expect(limitBreaches(c, m, poor, draftRecord("2026-03-01", draft("2026-03-02", "2026-03-20")))).toEqual([]);
    expect(limitBreaches(c, m, poor, draftRecord("2026-03-01", draft("2026-03-02", "2026-03-23", { halfEnd: true })))).toEqual([{ year: 2026, left: -10.5 }]);
  });

  it("someone already below the limit can still book sick days, and vacation in a year that has room", () => {
    const e = leave("big", "m_alice", "2026-03-02", "2026-03-20");
    const below = member("m_alice", { uid: "u_alice", entitlements: { "2026": 0, "2027": 25 } });
    const { m, c } = model({ members: [below], today: "2026-03-01", ledgers: { u_alice: [e] }, decisions: { u_alice: { big: decided("u_alice", e) } } });
    expect(balance(c, m, below, 2026).left).toBe(-15);
    expect(limitBreaches(c, m, below, draftRecord("2026-03-01", draft("2026-04-01", "2026-04-01", { type: "sick" })))).toEqual([]);
    expect(limitBreaches(c, m, below, draftRecord("2026-03-01", draft("2026-04-01", "2026-04-01")))).toEqual([{ year: 2026, left: -16 }]);
    // booked once 2027 has started, January 2027 comes out of 2027, and nothing carries in from 2026
    expect(limitBreaches(c, m, below, draftRecord("2027-01-04", draft("2027-01-11", "2027-01-12")))).toEqual([]);
  });

  it("checks the year a booking ahead is charged to", () => {
    const e = leave("big", "m_alice", "2026-03-02", "2026-03-20");
    const p = { ...poor, entitlements: { "2026": 6, "2027": 25 } };
    const { m, c } = model({ members: [p], today: "2026-11-23", ledgers: { u_alice: [e] }, decisions: { u_alice: { big: decided("u_alice", e) } } });
    // 2026 is at -9; one day in January 2027 booked now comes out of 2026
    expect(limitBreaches(c, m, p, draftRecord("2026-11-23", draft("2027-01-11", "2027-01-11")))).toEqual([]);
    expect(limitBreaches(c, m, p, draftRecord("2026-11-23", draft("2027-01-11", "2027-01-12")))).toEqual([{ year: 2026, left: -11 }]);
    // the same days booked once 2027 has started come out of 2027
    expect(limitBreaches(c, m, p, draftRecord("2027-01-04", draft("2027-01-11", "2027-01-12")))).toEqual([]);
  });

  it("checks later years a minus carries into", () => {
    const p = member("m_alice", { uid: "u_alice", entitlements: { "2027": 25, "2028": 0 }, carryover: { "2028": -34 } });
    const { m, c } = model({ members: [p], today: "2027-03-01", ledgers: {} });
    expect(balance(c, m, p, 2028).left).toBe(-9);
    expect(limitBreaches(c, m, p, draftRecord("2027-03-01", draft("2027-03-01", "2027-03-02")))).toEqual([{ year: 2028, left: -11 }]);
  });
});

describe("raw writes past the page", () => {
  const broke = member("m_alice", { uid: "u_alice", entitlements: { "2026": 0 } });
  const big = leave("big", "m_alice", "2026-03-02", "2026-03-13"); // 10 days → -10
  const base = { members: [broke], today: "2026-03-01", decisions: { u_alice: { big: decided("u_alice", big) } } };

  it("a self-accepted booking that goes past the limit waits for an approver", () => {
    const { m } = model({ ...base, ledgers: { u_alice: [big, leave("x", "m_alice", "2026-05-04", "2026-05-04")] } });
    expect(rec(m, "x")).toMatchObject({ status: "pending", auto: false, flags: ["over-limit"] });
    expect(sealsNeeded(m, "2026-03-01T10:00:00Z", "2026-03-01")).toEqual([]);
  });

  it("holds every such booking in that year, whatever its date", () => {
    const { m } = model({ ...base, ledgers: { u_alice: [big, leave("a", "m_alice", "2026-05-04", "2026-05-04"), leave("b", "m_alice", "2026-01-05", "2026-01-05")] } });
    expect(rec(m, "a").status).toBe("pending");
    expect(rec(m, "b").status).toBe("pending");
  });

  it("does not reopen a booking already recorded when the limit is raised later", () => {
    const x = leave("x", "m_alice", "2026-05-04", "2026-05-04");
    const seal = decided("u_alice", x, "approved", { by: null, grandfathered: true });
    const { m } = model({ ...base, settings: { minBalance: -2 }, ledgers: { u_alice: [big, x] }, decisions: { u_alice: { big: decided("u_alice", big), x: seal } } });
    expect(rec(m, "x").status).toBe("approved");
  });

  it("a booking ahead not recorded while its year runs waits for an approver (no grace while carry-over is by hand)", () => {
    const j = leave("j", "m_alice", "2027-01-11", "2027-01-11", { chargeYear: 2026 });
    const w = { members: [alice], ledgers: { u_alice: [j] } };
    expect(rec(model({ ...w, today: "2026-12-31" }).m, "j").status).toBe("approved");
    expect(rec(model({ ...w, today: "2027-01-01" }).m, "j")).toMatchObject({ status: "pending", flags: ["charge-closed"] });
  });

  it("once carry-over is automatic, an honest December booking gets until 31 January", () => {
    const a = member("m_alice", { uid: "u_alice", addedAt: "2027-01-01T00:00:00Z" });
    const j = leave("j", "m_alice", "2028-01-10", "2028-01-10", { chargeYear: 2027 });
    const w = { members: [a], ledgers: { u_alice: [j] } };
    expect(rec(model({ ...w, today: "2028-01-20" }).m, "j").status).toBe("approved");
    expect(rec(model({ ...w, today: "2028-02-01" }).m, "j")).toMatchObject({ status: "pending", flags: ["charge-closed"] });
  });

  it("a charge year changed after the decision keeps the decided one", () => {
    const j = leave("j", "m_alice", "2027-01-11", "2027-01-11", { chargeYear: 2026 });
    const dec = decided("u_alice", j);
    const { chargeYear: _, ...rewritten } = j;
    const { m, c } = model({ members: [alice], today: "2026-12-01", ledgers: { u_alice: [rewritten] }, decisions: { u_alice: { j: dec } } });
    expect(rec(m, "j").flags).toContain("changed-after-decision");
    expect(rec(m, "j").chargeYear).toBe(2026);
    expect(balance(c, m, alice, 2026).taken).toBe(1);
  });

  it("seals record the charge year in the fingerprint and snapshot", () => {
    const j = leave("j", "m_alice", "2027-01-11", "2027-01-11", { chargeYear: 2026 });
    const { m } = model({ members: [alice], today: "2026-12-01", ledgers: { u_alice: [j] } });
    const [seal] = sealsNeeded(m, "2026-12-01T10:00:00Z", "2026-12-01");
    expect(seal!.decision.fp).toMatch(/\|cy=2026$/);
    expect(seal!.decision.snapshot!.chargeYear).toBe(2026);
    expect("chargeYear" in recordSnapshot(rec(model({ members: [alice], ledgers: { u_alice: [leave("p", "m_alice", "2026-03-02", "2026-03-02")] } }).m, "p"))).toBe(false);
  });

  it("holds a self-accepted booking whose minus only shows in a later year it carries into", () => {
    // 2028 already holds a decided 30-day booking; short pieces written past the page use up 2027,
    // which leaves 2027 itself at 0 but carries nothing into 2028
    const who = (e27: number, e28: number) => member("m_alice", { uid: "u_alice", addedAt: "2027-01-01T00:00:00Z", entitlements: { "2027": e27, "2028": e28 } });
    const big28 = leave("b28", "m_alice", "2028-02-07", "2028-03-17"); // 30 working days
    const pieces = [leave("p1", "m_alice", "2027-03-01", "2027-03-02"), leave("p2", "m_alice", "2027-05-03", "2027-05-04")];
    const w = (m: ReturnType<typeof who>) => model({ members: [m], today: "2027-02-01", ledgers: { u_alice: [big28, ...pieces] }, decisions: { u_alice: { b28: decided("u_alice", big28) } } });
    const tight = who(4, 19); // 2027: 4 − 4 = 0; 2028: 19 + 0 − 30 = −11
    const held = w(tight);
    expect(balance(held.c, held.m, tight, 2027).left).toBe(0);
    expect(balance(held.c, held.m, tight, 2028).left).toBe(-11);
    expect(rec(held.m, "p1")).toMatchObject({ status: "pending", flags: ["over-limit"] });
    expect(rec(held.m, "p2").status).toBe("pending");
    const roomy = who(4, 25); // 2028: 25 − 30 = −5, within the limit
    expect(rec(w(roomy).m, "p1").status).toBe("approved");
  });

  it("an undecided booking charged to an archived year counts in its own year and is flagged", () => {
    const j = leave("j", "m_alice", "2027-01-11", "2027-01-11", { chargeYear: 2026 });
    const { m, c } = model({ members: [alice], today: "2028-06-01", settings: { archivedBefore: 2027 }, ledgers: { u_alice: [j] } });
    expect(rec(m, "j")).toMatchObject({ chargeYear: null, status: "pending", flags: ["charge-closed"] });
    expect(balance(c, m, alice, 2027).pending).toBe(1);
  });

  it("approving a booking charged to an archived year keeps it counted in its own year", () => {
    const j = leave("j", "m_alice", "2027-01-11", "2027-01-22", { chargeYear: 2026 }); // 10 days
    const w = { members: [alice], today: "2028-03-01", settings: { archivedBefore: 2027 } };
    const before = model({ ...w, ledgers: { u_alice: [j] } });
    const r = rec(before.m, "j");
    expect(r.chargeYear).toBeNull();
    // what decide() writes: the entry's fingerprint and the record's snapshot
    const dec: Decision = { entryId: "j", status: "approved", by: "m_boss", at: "2028-03-01T00:00:00Z", note: "", fp: fingerprint("u_alice", j), grandfathered: false, snapshot: recordSnapshot(r) };
    const after = model({ ...w, ledgers: { u_alice: [j] }, decisions: { u_alice: { j: dec } } });
    expect(rec(after.m, "j")).toMatchObject({ status: "approved", chargeYear: null });
    expect(balance(after.c, after.m, alice, 2027).taken).toBe(10);
  });

  it("a fake withdrawal after the start doesn't slip past the limit", () => {
    const w = leave("w", "m_alice", "2026-02-02", "2026-02-02", { withdrawnAt: "2026-02-10T00:00:00Z", withdrawnBy: "m_alice" });
    const { m } = model({ ...base, ledgers: { u_alice: [big, w] } });
    expect(rec(m, "w")).toMatchObject({ status: "pending" });
    expect(rec(m, "w").flags).toContain("over-limit");
  });
});

describe("balance cache", () => {
  it("keeps separate results for different member objects and different calendars", () => {
    const { m, c } = model({ members: [alice], ledgers: { u_alice: [leave("x", "m_alice", "2026-03-02", "2026-03-02")] } });
    expect(balance(c, m, alice, 2026).left).toBe(24);
    expect(balance(c, m, { ...alice, entitlements: { "2026": 30 } }, 2026).left).toBe(29);
    expect(balance(c, m, alice, 2026).left).toBe(24);
  });
});
