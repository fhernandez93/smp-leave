/**
 * v1 as an oracle: the same team data, once as v1 documents (read by the real
 * v1 page) and once migrated to v2 (read by the new page), must produce the
 * same Balances, Overtime and Days-off tables.
 */
import { expect, test, type Page } from "@playwright/test";
import { migrateV1 } from "../../src/platform/migrate";
import { openAs, teamSeed } from "./fixtures";

const v1Members = {
  m_boss: { uid: "u_boss", name: "Bea Boss", role: "manager" },
  m_alice: { uid: "u_alice", name: "Alice Muster", role: "member", entitlements: { "2026": 28 }, carryover: { "2026": 3 } },
  m_bob: { uid: "u_bob", name: "Bob Keller", role: "member" },
  m_carol: { uid: null, name: "Carol Roth", role: "member", entitlements: { "2026": 12.5 } },
};

const r = (id: string, memberId: string, type: string, start: string, end: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, data: { memberId, type, start, end, status, halfStart: false, halfEnd: false, halfPeriod: null, note: "", createdBy: memberId, createdAt: "2026-01-10T08:00:00Z", autoApproved: false, decidedBy: status === "pending" ? null : "m_boss", decidedAt: "2026-01-11T08:00:00Z", decisionNote: "", ...extra } });

const requests = [
  r("r1", "m_alice", "vacation", "2026-02-02", "2026-02-03", "approved", { autoApproved: true }),
  r("r2", "m_alice", "vacation", "2026-04-13", "2026-04-24", "approved"),
  r("r3", "m_alice", "vacation", "2026-07-06", "2026-07-17", "pending"),
  r("r4", "m_alice", "sick", "2026-01-19", "2026-01-21", "approved", { autoApproved: true }),
  r("r5", "m_bob", "vacation", "2026-04-30", "2026-05-01", "approved", { autoApproved: true, halfStart: true }),
  r("r6", "m_bob", "vacation", "2026-08-03", "2026-08-14", "rejected"),
  r("r7", "m_bob", "remote", "2026-03-06", "2026-03-06", "approved", { autoApproved: true }),
  r("r8", "m_bob", "vacation", "2026-12-21", "2027-01-08", "approved"),
  r("r9", "m_carol", "vacation", "2026-05-11", "2026-05-12", "cancelled", { cancelledBy: "m_carol" }),
  r("r10", "m_carol", "comp", "2026-03-13", "2026-03-13", "approved", { autoApproved: true }),
  r("r11", "m_boss", "vacation", "2026-10-26", "2026-10-30", "approved"),
];
const overtime = [
  { id: "o1", data: { memberId: "m_carol", date: "2026-02-07", hours: 8.4, status: "approved", decidedBy: "m_boss" } },
  { id: "o2", data: { memberId: "m_carol", date: "2026-02-14", hours: 3, status: "pending" } },
  { id: "o3", data: { memberId: "m_bob", date: "2026-01-31", hours: 2.5, status: "approved", decidedBy: "m_boss" } },
];

function seed() {
  const base = teamSeed();
  const docs: Record<string, Record<string, unknown>> = { "config/settings": base["config/settings"]! };
  for (const [id, m] of Object.entries(v1Members)) {
    docs[`members/${id}`] = { ...base[`members/${id}`], nameHint: "", entitlements: {}, carryover: {}, ...m };
  }
  for (const x of requests) docs[`requests/${x.id}`] = x.data;
  for (const x of overtime) docs[`overtime/${x.id}`] = x.data;
  const members = Object.entries(v1Members).map(([id, m]) => ({ id, uid: m.uid }));
  const v2 = migrateV1(members, requests, overtime, "2026-03-01T00:00:00Z");
  for (const [key, entries] of Object.entries(v2.ledgers)) docs[`ledger/${key}`] = { v: 2, entries };
  for (const [key, items] of Object.entries(v2.decisions)) docs[`decisions/${key}`] = { v: 2, items };
  return docs;
}

async function tables(page: Page) {
  await page.locator("#tabs button", { hasText: "Balances" }).click();
  const read = async (n: number) => {
    const t = page.locator("main table").nth(n);
    await expect(t.locator("tbody tr").first()).toBeVisible();
    return (await t.locator("tbody tr").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").replace(" (you)", "").trim());
  };
  return { balances: await read(0), overtime: await read(1), daysOff: await read(2) };
}

for (const year of [2026, 2027]) {
  test(`v2 shows the same balances, overtime and days off as v1 for ${year}`, async ({ context }) => {
    await context.addInitScript((y) => { try { localStorage.setItem("smpleave:year", String(y)); } catch { /* */ } }, year);
    const v1 = await openAs(context, "boss", { seed: seed(), path: "/v1" });
    const oracle = await tables(v1);
    const v2 = await openAs(context, "boss", { seed: seed() });
    const actual = await tables(v2);
    expect(actual.balances).toEqual(oracle.balances);
    expect(actual.overtime).toEqual(oracle.overtime);
    expect(actual.daysOff).toEqual(oracle.daysOff);
    expect(oracle.balances.length).toBe(4);
  });
}
