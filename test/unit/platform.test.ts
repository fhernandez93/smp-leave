import { beforeEach, describe, expect, it } from "vitest";
import { APP_COLLECTIONS, RULES } from "../../src/platform/capabilities";
import { backportToV1, migrateV1 } from "../../src/platform/migrate";
import { parseDecisions, parseLedger, parseSettings } from "../../src/platform/parse";
import { csvEscape, csvFilename, toCSV } from "../../src/domain/csv";
import { buildModel } from "../../src/domain/model";
import { installFakeClaude, type FakeArg } from "../fake/runtime";
import { cal, member } from "./helpers";

/* ------------------------------------------------------------------ */
describe("rules declaration", () => {
  const order = { view: 0, interact: 1, admin: 2, owner: 3 } as const;

  it("respects the publish constraints from db.d.ts", () => {
    expect(RULES.length).toBeLessThanOrEqual(64);
    for (const r of RULES) {
      if (r.read && r.write) expect(order[r.write]).toBeGreaterThanOrEqual(order[r.read]);
      const parts = r.path.split("/");
      parts.forEach((p, i) => { if (p === "{self}") expect(i).toBe(parts.length - 1); });
      if (r.path.endsWith("/{self}")) {
        const prefix = r.path.slice(0, -"/{self}".length);
        const pr = RULES.find((x) => x.path === prefix);
        if (pr) { expect(pr.read).toBeDefined(); expect(pr.write).toBeDefined(); }
      }
    }
  });

  it("keeps the root writable by Contributors (so can('data.write') is true for them)", () => {
    expect(RULES.find((r) => r.path === "")).toMatchObject({ read: "view", write: "interact" });
  });

  it("covers every collection the app touches with an explicit rule", () => {
    for (const c of APP_COLLECTIONS) {
      expect(RULES.some((r) => r.path === c || r.path.startsWith(c + "/"))).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
describe("fake runtime rule engine", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  type Db = { doc: (p: string) => { set: (d: unknown) => Promise<void>; get: () => Promise<{ exists: boolean }> } };
  async function as(level: FakeArg["viewer"] extends infer V ? V extends { level: infer L } ? L : never : never, uid: string): Promise<Db> {
    installFakeClaude({ viewer: { uid, name: uid, level }, rules: [...RULES], directory: [] });
    const g = globalThis as unknown as { claude: { use: (n: string) => Promise<unknown> } };
    return (await g.claude.use("db")) as Db;
  }

  it("lets a Contributor write only their own ledger", async () => {
    const db = await as("interact", "u_alice");
    await expect(db.doc("ledger/u_alice").set({ entries: {} })).resolves.toBeUndefined();
    await expect(db.doc("ledger/u_bob").set({ entries: {} })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(db.doc("ledger/m_carol").set({ entries: {} })).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("refuses decisions, roster, settings and archive writes below Editor", async () => {
    const db = await as("interact", "u_alice");
    for (const p of ["decisions/u_alice", "members/m_x", "config/settings", "archive/2025", "requests/r1", "overtime/o1"]) {
      await expect(db.doc(p).set({ x: 1 })).rejects.toMatchObject({ code: "invalid_argument" });
    }
  });

  it("lets an Editor write anyone's ledger and decisions", async () => {
    const db = await as("admin", "u_boss");
    await expect(db.doc("ledger/u_alice").set({ entries: {} })).resolves.toBeUndefined();
    await expect(db.doc("decisions/u_alice").set({ items: {} })).resolves.toBeUndefined();
  });

  it("lets a person claim only their own link", async () => {
    const db = await as("interact", "u_alice");
    await expect(db.doc("links/u_alice").set({ memberId: "m_a" })).resolves.toBeUndefined();
    await expect(db.doc("links/u_bob").set({ memberId: "m_a" })).rejects.toBeTruthy();
  });

  it("hides other people's join requests from Contributors but not from Editors", async () => {
    let db = await as("interact", "u_alice");
    await db.doc("joiners/u_alice").set({ nameHint: "A" });
    expect((await db.doc("joiners/u_alice").get()).exists).toBe(true);
    db = await as("interact", "u_bob");
    expect((await db.doc("joiners/u_alice").get()).exists).toBe(false);
    db = await as("admin", "u_boss");
    expect((await db.doc("joiners/u_alice").get()).exists).toBe(true);
  });

  it("keeps data/users private even from the owner", async () => {
    let db = await as("interact", "u_alice");
    await db.doc("data/users/u_alice/profile").set({ memberId: "m_a" });
    db = await as("owner", "u_owner");
    expect((await db.doc("data/users/u_alice/profile").get()).exists).toBe(false);
  });

  it("merges nested objects on update, replaces arrays, and refuses to update a missing document", async () => {
    const db = (await as("admin", "u_boss")) as unknown as { doc: (p: string) => { set: (d: unknown) => Promise<void>; update: (d: unknown) => Promise<void>; get: () => Promise<{ data: () => Record<string, unknown> }> } };
    await db.doc("ledger/u_x").set({ entries: { a: { n: 1, tags: [1, 2] } } });
    await db.doc("ledger/u_x").update({ entries: { b: { n: 2 } } });
    await db.doc("ledger/u_x").update({ entries: { a: { tags: [3] } } });
    expect((await db.doc("ledger/u_x").get()).data()).toEqual({ entries: { a: { n: 1, tags: [3] }, b: { n: 2 } } });
    await expect(db.doc("ledger/u_missing").update({ entries: {} })).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("gives viewers read but no write", async () => {
    let db = await as("admin", "u_boss");
    await db.doc("config/settings").set({ teamName: "T" });
    db = await as("view", "u_viewer");
    expect((await db.doc("config/settings").get()).exists).toBe(true);
    await expect(db.doc("ledger/u_viewer").set({ entries: {} })).rejects.toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
describe("parsers", () => {
  it("fills defaults for missing settings and drops junk", () => {
    const { settings, exists } = parseSettings({ teamName: 5, workdays: [1, 9, "x"], holidays: ["newyear", "bogus"], approvalThreshold: 3 });
    expect(exists).toBe(true);
    expect(settings.teamName).toBe("SMP Physics Team");
    expect(settings.workdays).toEqual([1]);
    expect(settings.holidays).toEqual(["newyear"]);
    expect(settings.approvalThreshold).toBe(3);
  });

  it("drops malformed and null ledger entries", () => {
    const entries = parseLedger({
      entries: {
        ok: { kind: "leave", memberId: "m_a", type: "vacation", start: "2026-03-02", end: "2026-03-03" },
        archived: null,
        backwards: { kind: "leave", memberId: "m_a", type: "vacation", start: "2026-03-05", end: "2026-03-03" },
        badType: { kind: "leave", memberId: "m_a", type: "party", start: "2026-03-02", end: "2026-03-03" },
        hugeOt: { kind: "overtime", memberId: "m_a", date: "2026-03-02", hours: 400 },
        ot: { kind: "overtime", memberId: "m_a", date: "2026-03-02", hours: 2.5 },
      },
    });
    expect(entries.map((e) => e.id)).toEqual(["ok", "ot"]);
  });

  it("parses decisions and skips nulls", () => {
    const d = parseDecisions({ items: { a: { status: "approved", fp: "x", snapshot: null }, b: null, c: { status: "maybe" } } });
    expect([...d.keys()]).toEqual(["a"]);
  });
});

/* ------------------------------------------------------------------ */
describe("v1 migration", () => {
  // shaped like the live data (ids and names invented)
  const members = [member("m_a", { uid: "u_a", role: "manager" }), member("m_b")];
  const requests = [
    { id: "r_manual", data: { memberId: "m_a", type: "vacation", start: "2026-11-20", end: "2026-11-27", status: "approved", autoApproved: false, decidedBy: "m_a", decidedAt: "2026-10-22T12:55:24Z", createdBy: "m_a", createdAt: "2026-10-22T12:55:19Z", halfStart: false, halfEnd: false, halfPeriod: null, note: "", decisionNote: "" } },
    { id: "r_auto", data: { memberId: "m_b", type: "vacation", start: "2026-03-02", end: "2026-03-02", status: "approved", autoApproved: true } },
    { id: "r_pend", data: { memberId: "m_b", type: "vacation", start: "2026-06-01", end: "2026-06-12", status: "pending" } },
    { id: "r_rej", data: { memberId: "m_b", type: "vacation", start: "2026-07-01", end: "2026-07-10", status: "rejected", decidedBy: "m_a", decisionNote: "beamtime" } },
    { id: "r_can", data: { memberId: "m_b", type: "remote", start: "2026-05-04", end: "2026-05-04", status: "cancelled", cancelledBy: "m_b" } },
    { id: "r_ghost", data: { memberId: "m_zz", type: "vacation", start: "2026-05-04", end: "2026-05-04", status: "approved" } },
  ];
  const overtime = [{ id: "o1", data: { memberId: "m_a", date: "2026-02-07", hours: 4, status: "approved", decidedBy: "m_a" } }];

  const out = migrateV1(members, requests, overtime, "2026-11-16T00:00:00Z");

  it("puts entries in the right ledgers with v1 ids", () => {
    expect(Object.keys(out.ledgers.u_a!)).toEqual(["r_manual", "o1"]);
    expect(Object.keys(out.ledgers.m_b!)).toEqual(["r_auto", "r_pend", "r_rej", "r_can"]);
    expect(out.skipped).toEqual([{ id: "r_ghost", reason: "unknown member" }]);
  });

  it("maps statuses so v2 shows exactly what v1 showed", () => {
    const parsedLedgers = new Map(Object.entries(out.ledgers).map(([k, v]) => [k, parseLedger({ entries: v })]));
    const parsedDecs = new Map(Object.entries(out.decisions).map(([k, v]) => [k, parseDecisions({ items: v })]));
    const m = buildModel({ cal: cal(), members, links: [], ledgers: parsedLedgers, decisions: parsedDecs, today: "2026-11-16" });
    const status = Object.fromEntries(m.records.map((r) => [r.id, r.status]));
    expect(status).toEqual({ r_manual: "approved", r_auto: "approved", r_pend: "pending", r_rej: "rejected", r_can: "cancelled", o1: "approved" });
    expect(m.records.find((r) => r.id === "r_auto")!.auto).toBe(true);
    expect(m.records.find((r) => r.id === "r_rej")!.decision!.note).toBe("beamtime");
  });

  it("is idempotent", () => {
    expect(migrateV1(members, requests, overtime, "2026-11-16T00:00:00Z")).toEqual(out);
  });

  it("round-trips through the v1 back-port", () => {
    const parsedLedgers = new Map(Object.entries(out.ledgers).map(([k, v]) => [k, parseLedger({ entries: v })]));
    const parsedDecs = new Map(Object.entries(out.decisions).map(([k, v]) => [k, parseDecisions({ items: v })]));
    const m = buildModel({ cal: cal(), members, links: [], ledgers: parsedLedgers, decisions: parsedDecs, today: "2026-11-16" });
    const back = backportToV1(m.records);
    expect(back.requests.r_manual).toMatchObject({ status: "approved", autoApproved: false, decidedBy: "m_a", start: "2026-11-20" });
    expect(back.requests.r_auto).toMatchObject({ status: "approved", autoApproved: true });
    expect(back.requests.r_rej).toMatchObject({ status: "rejected", decisionNote: "beamtime" });
    expect(back.overtime.o1).toMatchObject({ status: "approved", hours: 4 });
  });
});

describe("csv", () => {
  it("escapes like v1", () => {
    expect(csvEscape('a "b"')).toBe('"a ""b"""');
    expect(csvEscape("x;y")).toBe('"x;y"');
    expect(csvEscape(null)).toBe("");
    expect(toCSV([["a", "b"], [1, 2]])).toBe("﻿a,b\r\n1,2");
    expect(csvFilename("SMP Physics Team", 2026)).toBe("leave-smp-physics-team-2026.csv");
  });
});
