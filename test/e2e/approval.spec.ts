import { expect, test } from "@playwright/test";
import { book, openAs, ready, storeDump, tab } from "./fixtures";

test("a long booking waits for an approver, who approves it from their own page @tz", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  await book(alice, "2026-04-13", "2026-04-17");
  await expect(alice.locator(".toast").last()).toHaveText("Sent to an approver");
  await tab(alice, "Requests");
  const mine = alice.locator(".req", { hasText: "13 Apr – 17 Apr 2026" });
  await expect(mine).toContainText("Awaiting approval");
  await expect(mine.getByRole("button", { name: "Approve" })).toHaveCount(0);

  const boss = await openAs(context, "boss");
  await ready(boss);
  await expect(boss.locator("#tabs button", { hasText: "Requests" }).locator(".badge")).toHaveText("1");
  await tab(boss, "Requests");
  const row = boss.locator(".req", { hasText: "Alice Muster" }).filter({ hasText: "13 Apr" });
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row).toContainText("Approved");

  // Alice's page updates live
  await expect(mine).toContainText("Approved");
  const db = await storeDump(boss);
  const items = db["decisions/u_alice"]!.data.items as Record<string, { status: string; by: string }>;
  expect(Object.values(items).map((d) => [d.status, d.by])).toEqual([["approved", "m_boss"]]);
});

test("declining with a note shows the note to the person", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  await book(alice, "2026-06-01", "2026-06-12");
  const boss = await openAs(context, "boss");
  await ready(boss);
  await tab(boss, "Requests");
  await boss.locator(".req", { hasText: "1 Jun – 12 Jun 2026" }).getByRole("button", { name: "Decline" }).click();
  const dlg = boss.getByRole("dialog", { name: "Decline this leave" });
  await dlg.locator("#ask-input").fill("Clashes with the beamtime run");
  await dlg.getByRole("button", { name: "Decline" }).click();
  await tab(alice, "Requests");
  const row = alice.locator(".req", { hasText: "1 Jun – 12 Jun 2026" });
  await expect(row).toContainText("Declined");
  await expect(row).toContainText("Approver: Clashes with the beamtime run");
});

test("splitting leave into short pieces still needs approval", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  await book(alice, "2026-03-09", "2026-03-10");
  await expect(alice.locator(".toast").last()).toHaveText("Booked");
  await alice.getByRole("button", { name: "Book leave" }).first().click();
  const dlg = alice.getByRole("dialog", { name: "Book time away" });
  await dlg.locator("#book-from").fill("2026-03-11");
  await dlg.locator("#book-to").fill("2026-03-12");
  await expect(dlg.getByTestId("booking-calc")).toContainText("4 days in a row");
  await expect(dlg.locator(".ft .btn.primary")).toHaveText("Send for approval");
});

test("an approver's page seals self-booked leave so it can't be erased later", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  await book(alice, "2026-03-03", "2026-03-03"); // Tuesday, before "today" + 1
  const boss = await openAs(context, "boss");
  await ready(boss);
  // the sealing pass writes an automatic approval
  await expect.poll(async () => {
    const db = await storeDump(boss);
    const items = (db["decisions/u_alice"]?.data.items ?? {}) as Record<string, { status: string; grandfathered: boolean }>;
    return Object.values(items).map((d) => `${d.status}:${d.grandfathered}`);
  }, { timeout: 8000 }).toEqual(["approved:true"]);

  // Alice deletes the entry with devtools: it still counts
  await alice.evaluate(async () => {
    const db = await (window as unknown as { claude: { use: (n: string) => Promise<{ doc: (p: string) => { set: (d: unknown) => Promise<void> } }> } }).claude.use("db");
    await db.doc("ledger/u_alice").set({ v: 2, entries: {} });
  });
  await expect.poll(async () => Object.keys(((await storeDump(alice))["ledger/u_alice"]!.data.entries) as object).length).toBe(0);
  await alice.reload(); // a fresh page sees only what is stored now
  await tab(alice, "Balances");
  await expect(alice.getByTestId("balances").locator("tr", { hasText: "Alice" }).locator("td").nth(3)).toHaveText("1");
  await expect(alice.getByTestId("balances").locator("tr", { hasText: "Alice" }).locator("td").nth(5)).toHaveText("24");
});
