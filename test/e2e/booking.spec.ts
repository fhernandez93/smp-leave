import { expect, test } from "@playwright/test";
import { book, openAs, ready, storeDump, tab } from "./fixtures";

test.describe("booking as a regular Contributor", () => {
  test("Book leave is enabled for a regular user (v1 greyed it out) @tz @phone", async ({ context }) => {
    const alice = await openAs(context, "alice");
    await ready(alice);
    await expect(alice.locator("#whoami")).toHaveText("Alice Muster");
    for (const b of await alice.getByRole("button", { name: "Book leave" }).all()) await expect(b).toBeEnabled();
    await expect(alice.getByRole("button", { name: "Log overtime" }).first()).toBeEnabled();
    await expect(alice.getByTestId("readonly-banner")).toHaveCount(0);
    // the page body never scrolls sideways (the year grid scrolls inside its own panel)
    for (const t of ["Timeline", "Calendar", "Requests", "Balances", "Team"]) {
      await tab(alice, t);
      const overflow = await alice.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${t} overflows horizontally`).toBeLessThanOrEqual(0);
    }
  });

  test("a short booking is logged straight away and the balance drops @tz", async ({ context }) => {
    const alice = await openAs(context, "alice");
    await ready(alice);
    await expect(alice.getByTestId("my-left")).toContainText("25");
    await book(alice, "2026-03-04", "2026-03-05", { note: "Family visit" });
    await expect(alice.locator(".toast").last()).toHaveText("Booked");
    await expect(alice.getByTestId("my-left")).toContainText("23");
    await tab(alice, "Requests");
    const row = alice.locator(".req", { hasText: "4 Mar – 5 Mar 2026" });
    await expect(row).toContainText("Logged");
    await expect(row).toContainText("Family visit");
    // stored in Alice's own ledger, under her account id
    const db = await storeDump(alice);
    expect(Object.keys(db).filter((k) => k.startsWith("ledger/"))).toEqual(["ledger/u_alice"]);
  });

  test("a refused write does not grey out booking for the rest of the visit", async ({ context }) => {
    const alice = await openAs(context, "alice");
    await ready(alice);
    await alice.evaluate(() => (window as unknown as { __fake: { fail: (c: string, p: string) => void } }).__fake.fail("invalid_argument", "ledger/"));
    await alice.getByRole("button", { name: "Book leave" }).first().click();
    const dlg = alice.getByRole("dialog", { name: "Book time away" });
    await dlg.locator("#book-from").fill("2026-03-04");
    await dlg.locator("#book-to").fill("2026-03-04");
    await dlg.locator(".ft .btn.primary").click();
    await expect(alice.locator(".toast.bad")).toContainText("couldn’t be saved");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(alice.getByRole("button", { name: "Book leave" }).first()).toBeEnabled();
    await book(alice, "2026-03-04", "2026-03-04");
    await expect(alice.locator(".toast").last()).toHaveText("Booked");
  });

  test("half days and holidays are counted like v1", async ({ context }) => {
    const alice = await openAs(context, "alice");
    await ready(alice);
    await alice.getByRole("button", { name: "Book leave" }).first().click();
    const dlg = alice.getByRole("dialog", { name: "Book time away" });
    await dlg.locator("#book-from").fill("2026-04-30");
    await dlg.locator("#book-to").fill("2026-05-01");
    await expect(dlg.getByTestId("booking-calc")).toContainText("This uses 1.5 working days");
    await expect(dlg.getByTestId("booking-calc")).toContainText("Counted as a half day: Labour Day");
    await dlg.locator("#book-half-a").check();
    await expect(dlg.getByTestId("booking-calc")).toContainText("This uses 1 working day");
    await dlg.locator("#book-from").fill("2026-12-21");
    await dlg.locator("#book-to").fill("2027-01-03");
    await dlg.locator("#book-half-a").uncheck();
    await expect(dlg.getByTestId("booking-calc")).toContainText("This uses 7.5 working days");
    await expect(dlg.getByTestId("booking-calc")).toContainText("Free anyway: Christmas Day");
  });

  test("a person can cancel their own upcoming leave", async ({ context }) => {
    const alice = await openAs(context, "alice");
    await ready(alice);
    await book(alice, "2026-03-10", "2026-03-10");
    await tab(alice, "Requests");
    const row = alice.locator(".req", { hasText: "10 Mar 2026" });
    await row.getByRole("button", { name: "Cancel" }).click();
    await alice.getByRole("dialog").getByRole("button", { name: "Cancel the leave" }).click();
    await expect(row).toContainText("Cancelled");
    await tab(alice, "Timeline");
    await expect(alice.getByTestId("my-left")).toContainText("25");
  });
});

test.describe("read-only viewers", () => {
  test("a Viewer sees why they can't book, and no Settings tab", async ({ context }) => {
    const v = await openAs(context, "viewer", { memberPref: "m_bob" });
    await ready(v);
    await expect(v.getByTestId("readonly-banner")).toContainText("Contributor access");
    await expect(v.getByRole("button", { name: "Book leave" }).first()).toBeDisabled();
    await expect(v.locator("#tabs button", { hasText: "Settings" })).toHaveCount(0);
  });

  test("a page opened outside claude.ai says so", async ({ context }) => {
    const p = await openAs(context, null, { disable: ["db", "user", "downloads"] });
    await expect(p.locator(".gate")).toContainText("Shared data isn’t available");
  });
});
