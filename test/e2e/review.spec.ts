/** Tests added after code review: each covers a behaviour a mutation showed was untested. */
import { expect, test } from "@playwright/test";
import { book, openAs, ready, storeDump, tab, teamSeed } from "./fixtures";

const manager = (uid: string) => ({
  name: "", nameHint: "", uid, role: "manager", entitlements: {}, carryover: {}, archived: false, keepUnresolved: false,
  source: "directory", addedAt: "2026-01-01T00:00:00.000Z", leftAt: null,
});

test("with two approvers, an Editor can't approve their own request; the owner can", async ({ context }) => {
  // Alice is an approver on the roster too; Bea (Editor) books, Alice isn't an Editor so the owner decides
  const seed = teamSeed({ "members/m_owner": manager("u_owner") });
  const boss = await openAs(context, "boss", { seed });
  await ready(boss);
  await book(boss, "2026-04-13", "2026-04-17");
  await tab(boss, "Requests");
  const own = boss.locator(".req", { hasText: "13 Apr – 17 Apr 2026" });
  await expect(own).toContainText("Awaiting approval");
  await expect(own.getByRole("button", { name: "Approve" })).toHaveCount(0);
  const owner = await openAs(context, "owner", { seed });
  await ready(owner);
  await tab(owner, "Requests");
  await owner.locator(".req", { hasText: "13 Apr – 17 Apr 2026" }).getByRole("button", { name: "Approve" }).click();
  await expect(own).toContainText("Approved");
});

test("leave that has started can't be cancelled by its owner, only by an approver", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  await book(alice, "2026-03-02", "2026-03-03"); // today is Mon 2 March
  await tab(alice, "Requests");
  const row = alice.locator(".req", { hasText: "2 Mar – 3 Mar 2026" });
  await expect(row).toContainText("Logged");
  await expect(row.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await row.getByRole("button", { name: "Details" }).click();
  await expect(alice.getByRole("dialog")).toContainText("ask an approver to cancel it");
});

test("an Editor's own booking goes to their own ledger; one entered for someone else goes to the Editor-only ledger", async ({ context }) => {
  const boss = await openAs(context, "boss");
  await ready(boss);
  await book(boss, "2026-03-04", "2026-03-04");
  await boss.getByRole("button", { name: "Book leave" }).first().click();
  const dlg = boss.getByRole("dialog", { name: "Book time away" });
  await dlg.locator("#book-who").selectOption("m_alice");
  await dlg.locator("#book-from").fill("2026-03-05");
  await dlg.locator("#book-to").fill("2026-03-05");
  await dlg.locator(".ft .btn.primary").click();
  await expect(dlg).toBeHidden();
  const db = await storeDump(boss);
  expect(Object.keys(db).filter((k) => k.startsWith("ledger/")).sort()).toEqual(["ledger/m_alice", "ledger/u_boss"]);
});

test("two bookings in one ledger both survive (nested merge, not overwrite)", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  await book(alice, "2026-03-04", "2026-03-04");
  await book(alice, "2026-03-11", "2026-03-11");
  const db = await storeDump(alice);
  expect(Object.keys(db["ledger/u_alice"]!.data.entries as object)).toHaveLength(2);
});

test("bookings in an archived year are refused", async ({ context }) => {
  const seed = teamSeed();
  (seed["config/settings"] as Record<string, unknown>).archivedBefore = 2026;
  const alice = await openAs(context, "alice", { seed });
  await ready(alice);
  await alice.getByRole("button", { name: "Book leave" }).first().click();
  const dlg = alice.getByRole("dialog", { name: "Book time away" });
  await dlg.locator("#book-from").fill("2025-12-01");
  await dlg.locator("#book-to").fill("2025-12-02");
  await expect(dlg.getByTestId("booking-calc")).toContainText("2025 is archived");
  await expect(dlg.locator(".ft .btn.primary")).toBeDisabled();
});

test("access revoked mid-session turns the page read-only", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  await alice.evaluate(() => (window as unknown as { __fake: { revoke: () => void } }).__fake.revoke());
  await expect(alice.getByTestId("readonly-banner")).toBeVisible();
  await expect(alice.getByRole("button", { name: "Book leave" }).first()).toBeDisabled();
});

test("can('data.write') answering null keeps booking available", async ({ context }) => {
  const alice = await openAs(context, "alice", { canWrite: null });
  await ready(alice);
  await expect(alice.getByRole("button", { name: "Book leave" }).first()).toBeEnabled();
  await book(alice, "2026-03-04", "2026-03-04");
  await expect(alice.locator(".toast").last()).toHaveText("Booked");
});

test("an empty cached first snapshot never shows the setup screen to an Editor", async ({ context }) => {
  const boss = await openAs(context, "boss", { cacheFirst: "empty", latencyMs: 400 });
  const seen = await boss.evaluate(() => new Promise<boolean>((resolve) => {
    let setup = false;
    // look at what is rendered, not the page source (the inlined script contains the same words)
    const t = setInterval(() => { if (document.querySelector("main")?.textContent?.includes("Set up leave tracking")) setup = true; }, 10);
    setTimeout(() => { clearInterval(t); resolve(setup); }, 1500);
  }));
  expect(seen).toBe(false);
  await ready(boss);
  const db = await storeDump(boss);
  expect(Object.keys(db).filter((k) => k.startsWith("members/"))).toHaveLength(4);
});

test("typing a two-digit entitlement saves the whole number once", async ({ context }) => {
  const boss = await openAs(context, "boss");
  await ready(boss);
  await tab(boss, "Team");
  const field = boss.locator("#ent-m_alice");
  await field.fill("");
  await field.pressSequentially("30");
  await field.press("Enter");
  await expect(boss.locator(".toast").last()).toHaveText("Entitlement updated");
  await expect(field).toHaveValue("30");
  const db = await storeDump(boss);
  expect((db["members/m_alice"]!.data.entitlements as Record<string, number>)["2026"]).toBe(30);
  const writes = await boss.evaluate(() => (window as unknown as { __fake: { writeLog: { path: string }[] } }).__fake.writeLog.filter((w) => w.path === "members/m_alice").length);
  expect(writes).toBe(1);
});

test("unlinking an account stays unlinked", async ({ context }) => {
  const carol = await openAs(context, "carol");
  await carol.locator(".mrow", { hasText: "Carol Roth" }).getByRole("button", { name: "That’s me" }).click();
  await ready(carol);
  const boss = await openAs(context, "boss");
  await ready(boss);
  await expect.poll(async () => (await storeDump(boss))["members/m_carol"]!.data.uid, { timeout: 8000 }).toBe("u_carol");
  await tab(boss, "Team");
  await boss.getByTestId("member-m_carol").getByRole("button", { name: "Unlink account" }).click();
  await boss.waitForTimeout(3000); // longer than a sealing pass
  const db = await storeDump(boss);
  expect(db["members/m_carol"]!.data.uid).toBeNull();
  expect(db["links/u_carol"]).toBeUndefined();
});

test("a claim whose account name doesn't match waits for an Editor to confirm", async ({ context }) => {
  const mallory = await openAs(context, "mallory");
  await mallory.locator(".mrow", { hasText: "Carol Roth" }).getByRole("button", { name: "That’s me" }).click();
  await ready(mallory);
  const boss = await openAs(context, "boss");
  await ready(boss);
  await boss.waitForTimeout(2500);
  expect((await storeDump(boss))["members/m_carol"]!.data.uid).toBeNull();
  await tab(boss, "Team");
  const row = boss.locator(".mrow", { hasText: "was picked by the account “Mallory Blum”" });
  await row.getByRole("button", { name: "Unlink" }).click();
  await expect(mallory.getByRole("heading", { name: "Which one are you?" })).toBeVisible();
});

test("a page opened outside claude.ai says so @slow", async ({ context }) => {
  test.setTimeout(30_000);
  const p = await openAs(context, null, { noRuntime: true });
  await expect(p.locator(".gate")).toContainText("needs to be opened from claude.ai", { timeout: 15_000 });
});

test("a read-only visitor the platform says nothing about still gets in, read-only", async ({ context }) => {
  const v = await openAs(context, "outsider", { canWrite: null });
  await v.locator(".mrow", { hasText: "Carol Roth" }).getByRole("button", { name: "That’s me" }).click();
  await ready(v);
  await expect(v.locator("#whoami")).toContainText("Carol Roth");
  await expect(v.getByTestId("readonly-banner")).toBeVisible();
  await expect(v.getByRole("button", { name: "Book leave" }).first()).toBeDisabled();
  await expect(v.locator(".toast.bad")).toHaveCount(0);
});

test("unlinking someone who claimed the wrong name cancels what they booked under it", async ({ context }) => {
  const mallory = await openAs(context, "mallory");
  await mallory.locator(".mrow", { hasText: "Carol Roth" }).getByRole("button", { name: "That’s me" }).click();
  await ready(mallory);
  await book(mallory, "2026-03-04", "2026-03-05");
  const boss = await openAs(context, "boss");
  await ready(boss);
  // the booking is sealed while the claim stands
  await expect.poll(async () => Object.keys(((await storeDump(boss))["decisions/u_mallory"]?.data.items ?? {}) as object).length, { timeout: 8000 }).toBe(1);
  await tab(boss, "Team");
  await boss.locator(".mrow", { hasText: "was picked by the account “Mallory Blum”" }).getByRole("button", { name: "Unlink" }).click();
  await expect(boss.locator(".toast").last()).toHaveText("Unlinked");
  await tab(boss, "Balances");
  await expect(boss.getByTestId("balances").locator("tr", { hasText: "Carol Roth" }).locator("td").nth(3)).toHaveText("0");
});
