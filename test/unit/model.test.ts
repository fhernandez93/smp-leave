import { describe, expect, it } from "vitest";
import {
  balance, computeBindings, fingerprint, overtimeBalance, runDaysWith, sealsNeeded, snapshotOf, type LeaveRecord,
} from "../../src/domain/model";
import type { Decision, Entry } from "../../src/domain/types";
import { leave, member, model, ot } from "./helpers";

const alice = member("m_alice", { uid: "u_alice" });
const bob = member("m_bob", { uid: "u_bob" });
const carol = member("m_carol"); // added by name, not linked

function decided(key: string, e: Entry, status: Decision["status"], over: Partial<Decision> = {}): Decision {
  return { entryId: e.id, status, by: "m_boss", at: "2026-01-06T00:00:00Z", note: "", fp: fingerprint(key, e), grandfathered: false, snapshot: snapshotOf(e), ...over };
}
const rec = (m: { leave: LeaveRecord[] }, id: string) => m.leave.find((r) => r.id === id)!;

describe("identity bindings", () => {
  it("pinned uid wins and a pinned account cannot claim a second member", () => {
    const b = computeBindings([alice, carol], [{ uid: "u_alice", memberId: "m_carol", at: null }]);
    expect(b.uidOf.get("m_alice")).toBe("u_alice");
    expect(b.uidOf.has("m_carol")).toBe(false);
  });

  it("an uncontested claim binds but is marked unconfirmed", () => {
    const b = computeBindings([carol], [{ uid: "u_carol", memberId: "m_carol", at: null }]);
    expect(b.uidOf.get("m_carol")).toBe("u_carol");
    expect(b.unconfirmed.has("m_carol")).toBe(true);
  });

  it("contested claims bind nobody, whatever the timestamps say", () => {
    const b = computeBindings([carol], [
      { uid: "u_carol", memberId: "m_carol", at: "2026-02-01T00:00:00Z" },
      { uid: "u_mallory", memberId: "m_carol", at: "1970-01-01T00:00:00Z" },
    ]);
    expect(b.uidOf.has("m_carol")).toBe(false);
    expect(b.contested.get("m_carol")).toEqual(["u_carol", "u_mallory"]);
  });
});

describe("entry validity", () => {
  it("ignores entries booked under someone else's name", () => {
    const { m } = model({
      members: [alice, bob],
      ledgers: { u_bob: [leave("r1", "m_alice", "2026-03-02", "2026-03-02")] },
    });
    expect(m.leave).toHaveLength(0);
    expect(m.ignored).toEqual([{ ledgerKey: "u_bob", entryId: "r1", memberId: "m_alice" }]);
  });

  it("accepts admin-written entries in the memberId ledger", () => {
    const { m } = model({ members: [carol], ledgers: { m_carol: [leave("r1", "m_carol", "2026-03-02", "2026-03-02")] } });
    expect(m.leave).toHaveLength(1);
  });
});

describe("effective status", () => {
  it("auto-approves short vacation and marks longer runs pending", () => {
    const { m } = model({
      members: [alice],
      ledgers: { u_alice: [leave("short", "m_alice", "2026-03-02", "2026-03-03"), leave("long", "m_alice", "2026-04-13", "2026-04-17")] },
    });
    expect(rec(m, "short")).toMatchObject({ status: "approved", auto: true });
    expect(rec(m, "long")).toMatchObject({ status: "pending", auto: false });
  });

  it("closes threshold splitting: adjacent pieces are judged as one run", () => {
    // Mon–Tue and Wed–Thu: 4 days in one run > threshold 2
    const { m } = model({
      members: [alice],
      ledgers: { u_alice: [leave("a", "m_alice", "2026-03-02", "2026-03-03"), leave("b", "m_alice", "2026-03-04", "2026-03-05")] },
    });
    expect(rec(m, "a").status).toBe("pending");
    expect(rec(m, "b").status).toBe("pending");
  });

  it("joins runs across weekends and closures", () => {
    // Thu–Fri then Mon: weekend in between → one run of 3
    const { m } = model({
      members: [alice],
      ledgers: { u_alice: [leave("a", "m_alice", "2026-03-05", "2026-03-06"), leave("b", "m_alice", "2026-03-09", "2026-03-09")] },
    });
    expect(rec(m, "b").status).toBe("pending");
  });

  it("never needs approval for sick or remote", () => {
    const { m } = model({ members: [alice], ledgers: { u_alice: [leave("s", "m_alice", "2026-03-02", "2026-03-13", { type: "sick" })] } });
    expect(rec(m, "s")).toMatchObject({ status: "approved", auto: true });
  });

  it("applies a matching decision", () => {
    const e = leave("long", "m_alice", "2026-04-13", "2026-04-17");
    const { m } = model({ members: [alice], ledgers: { u_alice: [e] }, decisions: { u_alice: { long: decided("u_alice", e, "rejected") } } });
    expect(rec(m, "long").status).toBe("rejected");
  });

  it("keeps the decided version when the entry is edited after approval", () => {
    const orig = leave("r", "m_alice", "2026-04-13", "2026-04-15");
    const edited = { ...orig, end: "2026-04-30" };
    const { m, c } = model({ members: [alice], ledgers: { u_alice: [edited] }, decisions: { u_alice: { r: decided("u_alice", orig, "approved") } } });
    const r = rec(m, "r");
    expect(r.end).toBe("2026-04-15");
    expect(r.status).toBe("approved");
    expect(r.flags).toContain("changed-after-decision");
    expect(balance(c, m, alice, 2026).taken).toBe(3);
  });

  it("still counts decided leave whose entry was deleted", () => {
    const e = leave("r", "m_alice", "2026-02-02", "2026-02-04");
    const { m, c } = model({ members: [alice], ledgers: { u_alice: [] }, decisions: { u_alice: { r: decided("u_alice", e, "approved", { by: null, grandfathered: true }) } } });
    expect(rec(m, "r").flags).toContain("entry-removed");
    expect(balance(c, m, alice, 2026).taken).toBe(3);
  });
});

describe("withdrawals", () => {
  const future = leave("f", "m_alice", "2026-05-04", "2026-05-05", { withdrawnAt: "2026-02-01T00:00:00Z" });
  const past = leave("p", "m_alice", "2026-02-02", "2026-02-03", { withdrawnAt: "2026-01-01T00:00:00Z" /* backdated */ });

  it("honours a withdrawal before the start", () => {
    const { m } = model({ members: [alice], ledgers: { u_alice: [future] } });
    expect(rec(m, "f").status).toBe("cancelled");
  });

  it("ignores a backdated withdrawal of leave already taken (unsealed)", () => {
    const { m, c } = model({ members: [alice], ledgers: { u_alice: [past] }, today: "2026-03-01" });
    expect(rec(m, "p")).toMatchObject({ status: "approved", flags: ["withdrawal-unconfirmed"] });
    expect(balance(c, m, alice, 2026).taken).toBe(2);
  });

  it("ignores a withdrawal of sealed leave once it has started", () => {
    const clean = { ...past, withdrawnAt: null };
    const { m } = model({
      members: [alice], ledgers: { u_alice: [past] }, today: "2026-03-01",
      decisions: { u_alice: { p: decided("u_alice", clean, "approved", { by: null, grandfathered: true }) } },
    });
    expect(rec(m, "p").status).toBe("approved");
  });

  it("lets a person withdraw a pending request at any time", () => {
    const pend = leave("x", "m_alice", "2026-02-02", "2026-02-13", { withdrawnAt: "2026-02-20T00:00:00Z" });
    const { m } = model({ members: [alice], ledgers: { u_alice: [pend] }, today: "2026-03-01" });
    expect(rec(m, "x").status).toBe("cancelled");
  });
});

describe("sealing", () => {
  it("seals auto-approved entries and upcoming withdrawals, nothing else", () => {
    const auto = leave("a", "m_alice", "2026-03-02", "2026-03-02");
    const pending = leave("p", "m_alice", "2026-06-01", "2026-06-12");
    const gone = leave("w", "m_alice", "2026-07-06", "2026-07-06", { withdrawnAt: "2026-02-01T00:00:00Z" });
    const { m } = model({ members: [alice], ledgers: { u_alice: [auto, pending, gone] } });
    const seals = sealsNeeded(m, "2026-03-01T10:00:00Z", "2026-03-01");
    expect(seals.map((s) => [s.entryId, s.decision.status])).toEqual(
      expect.arrayContaining([["a", "approved"], ["w", "cancelled"]]),
    );
    expect(seals).toHaveLength(2);
    expect(seals.find((s) => s.entryId === "a")!.decision.fp).toBe(fingerprint("u_alice", auto));
  });

  it("is idempotent once sealed", () => {
    const auto = leave("a", "m_alice", "2026-03-02", "2026-03-02");
    const first = model({ members: [alice], ledgers: { u_alice: [auto] } });
    const s = sealsNeeded(first.m, "t", "2026-03-01")[0]!;
    const second = model({ members: [alice], ledgers: { u_alice: [auto] }, decisions: { u_alice: { a: s.decision } } });
    expect(sealsNeeded(second.m, "t", "2026-03-01")).toEqual([]);
    expect(rec(second.m, "a")).toMatchObject({ status: "approved", auto: true });
  });

  it("keeps a sealed status when the threshold later drops", () => {
    const e = leave("a", "m_alice", "2026-03-02", "2026-03-03");
    const s = sealsNeeded(model({ members: [alice], ledgers: { u_alice: [e] } }).m, "t", "2026-03-01")[0]!;
    const after = model({ settings: { approvalThreshold: 0 }, members: [alice], ledgers: { u_alice: [e] }, decisions: { u_alice: { a: s.decision } } });
    expect(rec(after.m, "a").status).toBe("approved");
  });
});

describe("balances and overtime", () => {
  it("computes vacation balance with entitlement, carry-over and pending", () => {
    const a = { ...alice, entitlements: { "2026": 30 }, carryover: { "2026": 2 } };
    const { m, c } = model({
      members: [a],
      ledgers: { u_alice: [leave("t", "m_alice", "2026-03-02", "2026-03-03"), leave("p", "m_alice", "2026-04-13", "2026-04-17"), leave("s", "m_alice", "2026-03-10", "2026-03-10", { type: "sick" })] },
    });
    expect(balance(c, m, a, 2026)).toMatchObject({ ent: 30, carry: 2, auto: 0, adj: 2, taken: 2, pending: 5, sick: 1, remote: 0, left: 25, ahead: 0 });
  });

  it("banks only approved overtime and spends it on time off in lieu", () => {
    const o1 = ot("o1", "m_alice", "2026-02-07", 8.4);
    const o2 = ot("o2", "m_alice", "2026-02-14", 4);
    const comp = leave("c", "m_alice", "2026-03-02", "2026-03-02", { type: "comp" });
    const { m, c } = model({ members: [alice], ledgers: { u_alice: [o1, o2, comp] }, decisions: { u_alice: { o1: decided("u_alice", o1, "approved") } } });
    const b = overtimeBalance(c, m, "m_alice", [{ m_alice: { earnedH: 10, spentH: 2 } }]);
    expect(b.banked).toBeCloseTo(18.4);
    expect(b.pending).toBe(4);
    expect(b.spent).toBeCloseTo(10.4);
    expect(b.left).toBeCloseTo(8);
  });

  it("measures the run a draft would join", () => {
    const { m, c } = model({ members: [alice], ledgers: { u_alice: [leave("a", "m_alice", "2026-03-02", "2026-03-03")] } });
    expect(runDaysWith(c, m, { memberId: "m_alice", type: "vacation", start: "2026-03-04", end: "2026-03-04", halfStart: false, halfEnd: false })).toBe(3);
    expect(runDaysWith(c, m, { memberId: "m_alice", type: "vacation", start: "2026-03-11", end: "2026-03-11", halfStart: false, halfEnd: false })).toBe(1);
  });

  it("excludes records that end in an archived year", () => {
    const { m } = model({ settings: { archivedBefore: 2026 }, members: [alice], ledgers: { u_alice: [leave("old", "m_alice", "2025-03-02", "2025-03-03"), leave("x", "m_alice", "2025-12-29", "2026-01-05")] } });
    expect(m.leave.map((r) => r.id)).toEqual(["x"]);
    expect(m.late.map((r) => r.id)).toEqual(["old"]);
  });
});

describe("review findings", () => {
  it("a sealed entry rewritten as another kind keeps its sealed kind (no forged overtime)", () => {
    const sick = leave("r1", "m_alice", "2026-02-02", "2026-02-02", { type: "sick" });
    const seal = decided("u_alice", sick, "approved", { by: null, grandfathered: true });
    const forged = { ...ot("r1", "m_alice", "2026-02-02", 24) };
    const { m, c } = model({ members: [alice], ledgers: { u_alice: [forged] }, decisions: { u_alice: { r1: seal } } });
    expect(m.overtime).toHaveLength(0);
    expect(m.leave[0]).toMatchObject({ id: "r1", type: "sick", flags: ["changed-after-decision"] });
    expect(overtimeBalance(c, m, "m_alice").banked).toBe(0);
  });

  it("a decision without a snapshot does not apply to an entry that no longer matches it", () => {
    const e = leave("r1", "m_alice", "2026-04-13", "2026-04-17");
    const d = decided("u_alice", { ...e, end: "2026-04-14" }, "approved", { snapshot: null });
    const { m } = model({ members: [alice], ledgers: { u_alice: [e] }, decisions: { u_alice: { r1: d } } });
    expect(rec(m, "r1")).toMatchObject({ status: "pending", decision: null, flags: ["changed-after-decision"] });
  });

  it("withdrawing an upcoming sick or remote day takes effect at once", () => {
    const up = leave("s", "m_alice", "2026-05-04", "2026-05-04", { type: "remote", withdrawnAt: "2026-03-01T00:00:00Z" });
    const past = leave("p", "m_alice", "2026-02-02", "2026-02-02", { type: "sick", withdrawnAt: "2026-01-01T00:00:00Z" });
    const { m } = model({ members: [alice], ledgers: { u_alice: [up, past] }, today: "2026-03-01" });
    expect(rec(m, "s").status).toBe("cancelled");
    expect(rec(m, "p")).toMatchObject({ status: "approved", flags: ["withdrawal-unconfirmed"] });
    expect(sealsNeeded(m, "t", "2026-03-01").map((x) => [x.entryId, x.decision.status])).toEqual([["s", "cancelled"]]);
  });

  it("a link cannot take over a roster entry already tied to an account", () => {
    const b = computeBindings([alice], [{ uid: "u_mallory", memberId: "m_alice", at: "1970-01-01T00:00:00Z" }]);
    expect(b.uidOf.get("m_alice")).toBe("u_alice");
    expect(b.memberOf.has("u_mallory")).toBe(false);
  });
});
