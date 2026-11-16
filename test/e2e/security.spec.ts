import { expect, test, type Page } from "@playwright/test";
import { openAs, ready, storeDump, tab, teamSeed } from "./fixtures";

/** Run a raw db call from the page, like someone using devtools. Resolves "ok" or the error code. */
async function raw(page: Page, op: "set" | "update", path: string, data: unknown): Promise<string> {
  return page.evaluate(async ([op, path, data]) => {
    const db = await (window as unknown as { claude: { use: (n: string) => Promise<Record<string, (p: string) => Record<string, (d: unknown) => Promise<void>>>> } }).claude.use("db");
    try {
      await db.doc!(path as string)[op as string]!(data);
      return "ok";
    } catch (e) {
      return (e as { code: string }).code;
    }
  }, [op, path, data] as const);
}

const entry = (memberId: string, start: string, end: string) => ({
  kind: "leave", memberId, type: "vacation", start, end, halfStart: false, halfEnd: false, halfPeriod: null,
  note: "", createdBy: memberId, createdAt: "2026-03-01T00:00:00Z", withdrawnAt: null, withdrawnBy: null,
});

test("a Contributor cannot approve, edit the roster or touch someone else's ledger", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  expect(await raw(alice, "set", "decisions/u_alice", { items: { x: { status: "approved" } } })).toBe("invalid_argument");
  expect(await raw(alice, "update", "members/m_alice", { role: "manager" })).toBe("invalid_argument");
  expect(await raw(alice, "set", "config/settings", { approvalThreshold: 99 })).toBe("invalid_argument");
  expect(await raw(alice, "set", "ledger/u_bob", { entries: {} })).toBe("invalid_argument");
  expect(await raw(alice, "set", "ledger/m_carol", { entries: {} })).toBe("invalid_argument");
  expect(await raw(alice, "set", "links/u_bob", { memberId: "m_alice" })).toBe("invalid_argument");
});

test("leave booked under someone else's name in your own ledger is ignored", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  expect(await raw(alice, "set", "ledger/u_alice", { v: 2, entries: { fake: entry("m_bob", "2026-03-16", "2026-03-20") } })).toBe("ok");
  const boss = await openAs(context, "boss");
  await ready(boss);
  await tab(boss, "Requests");
  await expect(boss.locator(".req", { hasText: "16 Mar" })).toHaveCount(0);
  await tab(boss, "Team");
  await expect(boss.getByText("booked under a name that doesn’t belong")).toBeVisible();
});

test("editing an approved request afterwards keeps the approved version", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  const e = entry("m_alice", "2026-04-13", "2026-04-17");
  expect(await raw(alice, "set", "ledger/u_alice", { v: 2, entries: { r1: e } })).toBe("ok");
  const boss = await openAs(context, "boss");
  await ready(boss);
  await tab(boss, "Requests");
  await boss.locator(".req", { hasText: "13 Apr" }).getByRole("button", { name: "Approve" }).click();
  await expect(boss.locator(".req", { hasText: "13 Apr" })).toContainText("Approved");
  // stretch it to five weeks behind the approver's back
  expect(await raw(alice, "update", "ledger/u_alice", { entries: { r1: { ...e, end: "2026-05-15" } } })).toBe("ok");
  // wait until the edit has reached the approver's page, then check it changed nothing
  await expect(boss.locator(".req", { hasText: "13 Apr – 17 Apr 2026" })).toContainText("Changed after it was decided");
  await tab(boss, "Balances");
  await expect(boss.getByTestId("balances").locator("tr", { hasText: "Alice" }).locator("td").nth(3)).toHaveText("5");
  await tab(boss, "Requests");
  await expect(boss.locator(".req", { hasText: "13 Apr – 17 Apr 2026" })).toContainText("Changed after it was decided");
});

test("a second account claiming the same name binds nobody until an Editor decides", async ({ context }) => {
  // Carol was typed in by name; Mallory claims her before she does
  const mallory = await openAs(context, "mallory");
  await mallory.getByRole("button", { name: "That’s me" }).first().waitFor();
  await mallory.locator(".mrow", { hasText: "Carol Roth" }).getByRole("button", { name: "That’s me" }).click();
  await ready(mallory);
  const carol = await openAs(context, "carol", { memberPref: "m_carol" });
  // Carol's page does not offer her own (claimed) name any more: she claims it via the raw call a real picker would make
  expect(await raw(carol, "set", "links/u_carol", { memberId: "m_carol", at: "1970-01-01T00:00:00Z" })).toBe("ok");
  const boss = await openAs(context, "boss", { seed: teamSeed() });
  await ready(boss);
  await tab(boss, "Team");
  const ask = boss.locator(".mrow", { hasText: "was picked by 2 accounts" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "It’s Carol Roth" }).click();
  await expect(boss.locator(".mrow", { hasText: "was picked by 2 accounts" })).toHaveCount(0);
  const db = await storeDump(boss);
  expect(db["members/m_carol"]!.data.uid).toBe("u_carol");
});

test("subscriptions stay bounded whatever the data size", async ({ context }) => {
  const boss = await openAs(context, "boss");
  await ready(boss);
  for (const t of ["Calendar", "Requests", "Balances", "Team", "Settings", "Timeline"]) await tab(boss, t);
  const n = await boss.evaluate(() => (window as unknown as { __fake: { subscriptions: () => number } }).__fake.subscriptions());
  expect(n).toBeLessThanOrEqual(8);
});

test("the page is self-contained: nothing loads except Google Fonts", async ({ context }) => {
  const blocked: string[] = [];
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "localhost" || u.hostname.endsWith("fonts.googleapis.com") || u.hostname.endsWith("fonts.gstatic.com")) return route.continue();
    blocked.push(u.href);
    return route.abort();
  });
  const alice = await openAs(context, "alice");
  await ready(alice);
  expect(blocked).toEqual([]);
});
