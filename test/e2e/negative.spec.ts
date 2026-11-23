import { expect, test, type Page } from "@playwright/test";
import { book, openAs, ready, storeDump, tab, teamSeed } from "./fixtures";

/** Alice's allowance per year, and optional settings on top of the default team. */
function seed(entitlements: Record<string, number>, settings: Record<string, unknown> = {}) {
  const base = teamSeed();
  return {
    ...base,
    "config/settings": { ...base["config/settings"], ...settings },
    "members/m_alice": { ...base["members/m_alice"], entitlements },
  };
}

async function openBooking(page: Page, from: string, to: string) {
  await page.getByRole("button", { name: "Book leave" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Book time away" });
  await dlg.locator("#book-from").fill(from);
  await dlg.locator("#book-to").fill(to);
  return dlg;
}

test("a balance may go into minus down to the limit, and no further", async ({ context }) => {
  const alice = await openAs(context, "alice", { seed: seed({ "2026": 5 }) });
  await ready(alice);
  // 10–28 August 2026: 15 working days → 5 − 15 = −10
  const dlg = await openBooking(alice, "2026-08-10", "2026-08-28");
  const calc = dlg.getByTestId("booking-calc");
  await expect(calc).toContainText("2026 would be at -10 vacation days (lowest allowed -10).");
  await expect(calc.locator(".warn", { hasText: "would be at -10" })).toBeVisible();
  await expect(dlg.locator(".ft .btn.primary")).toBeEnabled();
  // one more day → −11
  await dlg.locator("#book-to").fill("2026-08-31");
  await expect(calc).toContainText("That would take you to -11 days in 2026; the lowest allowed is -10.");
  await expect(dlg.locator(".ft .btn.primary")).toBeDisabled();
  // sick days are never limited
  await dlg.getByRole("button", { name: "Sick", exact: true }).click();
  await expect(dlg.locator(".ft .btn.primary")).toBeEnabled();
});

test("vacation in next year booked now comes out of this year", async ({ context }) => {
  const alice = await openAs(context, "alice", { seed: seed({ "2026": 25, "2027": 25 }) });
  await ready(alice);
  const dlg = await openBooking(alice, "2027-01-11", "2027-01-12");
  await expect(dlg.getByTestId("booking-calc")).toContainText("Booked ahead: these days come out of your 2026 vacation days.");
  await expect(dlg.getByTestId("booking-calc")).toContainText("23 vacation days would remain in 2026.");
  await dlg.locator(".ft .btn.primary").click();
  await expect(dlg).toBeHidden();
  await expect(alice.getByTestId("my-left")).toContainText("23");
  const db = await storeDump(alice);
  const entries = db["ledger/u_alice"]!.data.entries as Record<string, { chargeYear?: number }>;
  expect(Object.values(entries).map((e) => e.chargeYear)).toEqual([2026]);

  await tab(alice, "Balances");
  const row = alice.getByTestId("balances").locator("tr", { hasText: "Alice Muster" });
  await expect(row.locator("td").nth(3)).toHaveText("2");
  await expect(alice.getByTestId("balances-note")).toContainText("include vacation in 2027 that was booked ahead against 2026");
  await alice.getByRole("combobox", { name: "Year" }).first().selectOption("2027");
  await expect(row.locator("td").nth(3)).toHaveText("0");
  await expect(row.locator("td").nth(5)).toHaveText("25");
  await expect(alice.getByTestId("balances-note")).toContainText("Carry-overs into 2027 start at 0 and are entered by hand");
});

test("vacation can be booked up to the end of next year only", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  const dlg = await openBooking(alice, "2028-01-10", "2028-01-10");
  await expect(dlg.getByTestId("booking-calc")).toContainText("Vacation can be booked up to the end of 2027.");
  await expect(dlg.locator(".ft .btn.primary")).toBeDisabled();
  await dlg.getByRole("button", { name: "Remote", exact: true }).click();
  await expect(dlg.locator(".ft .btn.primary")).toBeEnabled();
});

test("an Editor changes the limit and the booking dialog follows", async ({ context }) => {
  const boss = await openAs(context, "boss", { seed: seed({ "2026": 5 }) });
  await ready(boss);
  await tab(boss, "Settings");
  await boss.locator("#set-min").fill("-2");
  await boss.getByRole("button", { name: "Save settings" }).click();
  await expect(boss.locator(".toast").last()).toHaveText("Settings saved");
  const alice = await openAs(context, "alice");
  await ready(alice);
  // 3–11 August: 7 working days → 5 − 7 = −2 is fine, −3 is not
  const dlg = await openBooking(alice, "2026-08-03", "2026-08-11");
  await expect(dlg.locator(".ft .btn.primary")).toBeEnabled();
  await dlg.locator("#book-to").fill("2026-08-12");
  await expect(dlg.getByTestId("booking-calc")).toContainText("the lowest allowed is -2.");
  await expect(dlg.locator(".ft .btn.primary")).toBeDisabled();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await book(alice, "2026-08-03", "2026-08-04");
  await expect(alice.locator(".toast").last()).toHaveText("Booked");
});

test("a booking written past the page that goes below the limit waits for an approver", async ({ context }) => {
  const alice = await openAs(context, "alice", { seed: seed({ "2026": 0 }, { minBalance: 0 }) });
  await ready(alice);
  const ok = await alice.evaluate(async () => {
    const db = await (window as unknown as { claude: { use: (n: string) => Promise<{ doc: (p: string) => { set: (d: unknown) => Promise<void> } }> } }).claude.use("db");
    await db.doc("ledger/u_alice").set({ v: 2, entries: { sneaky: {
      kind: "leave", memberId: "m_alice", type: "vacation", start: "2026-05-04", end: "2026-05-04", halfStart: false, halfEnd: false, halfPeriod: null,
      note: "", createdBy: "m_alice", createdAt: "2026-03-01T00:00:00Z", withdrawnAt: null, withdrawnBy: null,
    } } });
    return "ok";
  });
  expect(ok).toBe("ok");
  const boss = await openAs(context, "boss");
  await ready(boss);
  await tab(boss, "Requests");
  const row = boss.locator(".req", { hasText: "4 May 2026" });
  await expect(row).toContainText("Awaiting approval");
  await expect(row).toContainText("Would go below the lowest balance allowed");
  // and the approver's page never seals it as accepted
  await boss.waitForTimeout(1500);
  const db = await storeDump(boss);
  const items = (db["decisions/u_alice"]?.data.items ?? {}) as Record<string, unknown>;
  expect(items.sneaky).toBeUndefined();
});

test("Team says that carry-overs into 2027 are entered by hand", async ({ context }) => {
  const boss = await openAs(context, "boss");
  await ready(boss);
  await tab(boss, "Team");
  await expect(boss.getByTestId("carry-manual-note")).toHaveCount(0);
  await boss.getByRole("combobox", { name: "Year" }).first().selectOption("2027");
  await expect(boss.getByTestId("carry-manual-note")).toContainText("Carry-overs into 2027 start at 0 for everyone");
  await expect(boss.getByTestId("carry-hint-m_alice")).toHaveText("2026 ended at 25, not carried automatically");
  await boss.getByRole("combobox", { name: "Year" }).first().selectOption("2028");
  await expect(boss.getByTestId("carry-manual-note")).toHaveCount(0);
  await expect(boss.getByTestId("carry-hint-m_alice")).toHaveText("+25 from 2027 automatically");
});
