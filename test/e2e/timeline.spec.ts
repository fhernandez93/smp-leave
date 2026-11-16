import { expect, test, type Page } from "@playwright/test";
import { book, openAs, ready, tab, teamSeed } from "./fixtures";

const entry = (memberId: string, start: string, end: string, over: Record<string, unknown> = {}) => ({
  kind: "leave", memberId, type: "vacation", start, end, halfStart: false, halfEnd: false, halfPeriod: null,
  note: "", createdBy: memberId, createdAt: "2026-02-01T00:00:00Z", withdrawnAt: null, withdrawnBy: null, ...over,
});

const period = (p: Page) => p.getByTestId("tl-period");
const view = (p: Page, v: "Year" | "Month" | "Week") => p.getByRole("group", { name: "Timeline view" }).getByRole("button", { name: v, exact: true });

test("Leaves at a glance switches between year, month and week and steps with the arrows @tz", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  await expect(alice.getByRole("heading", { name: "Leaves at a glance" })).toBeVisible();
  await expect(alice.getByText("The year at a glance")).toHaveCount(0);

  // year (the desktop default)
  await expect(view(alice, "Year")).toHaveAttribute("aria-pressed", "true");
  await expect(period(alice)).toHaveText("2026");
  await alice.getByRole("button", { name: "Next year" }).click();
  await expect(period(alice)).toHaveText("2027");
  await alice.getByRole("button", { name: "Today", exact: true }).click();
  await expect(period(alice)).toHaveText("2026");

  // month
  await view(alice, "Month").click();
  await expect(period(alice)).toHaveText("March 2026");
  await expect(alice.getByTestId("tl-grid").locator(".dh")).toHaveCount(31);
  await alice.getByRole("button", { name: "Next month" }).click();
  await expect(period(alice)).toHaveText("April 2026");
  await expect(alice.getByTestId("tl-grid").locator(".dh")).toHaveCount(30);
  // the month is shared with the Calendar tab
  await tab(alice, "Calendar");
  await expect(alice.getByRole("heading", { name: "April 2026" })).toBeVisible();
  await tab(alice, "Timeline");
  await alice.getByRole("button", { name: "Previous month" }).click();
  await alice.getByRole("button", { name: "Previous month" }).click();
  await expect(period(alice)).toHaveText("February 2026");
  await alice.getByRole("button", { name: "Today", exact: true }).click();
  await expect(period(alice)).toHaveText("March 2026");

  // week
  await view(alice, "Week").click();
  await expect(period(alice)).toHaveText("2 Mar – 8 Mar 2026");
  await expect(alice.getByText("Week 10")).toBeVisible();
  await expect(alice.getByTestId("tl-grid").locator(".dh")).toHaveCount(7);
  await alice.getByRole("button", { name: "Previous week" }).click();
  await expect(period(alice)).toHaveText("23 Feb – 1 Mar 2026");
  // stepping a week moves the month with it
  await view(alice, "Month").click();
  await expect(period(alice)).toHaveText("February 2026");
  await view(alice, "Week").click();
  await expect(period(alice)).toHaveText("23 Feb – 1 Mar 2026");
  await alice.getByRole("button", { name: "Today", exact: true }).click();
  await expect(period(alice)).toHaveText("2 Mar – 8 Mar 2026");

  // the chosen view is remembered
  await alice.reload();
  await ready(alice);
  await expect(view(alice, "Week")).toHaveAttribute("aria-pressed", "true");
  await expect(period(alice)).toHaveText("2 Mar – 8 Mar 2026");
});

test("a booking shows in every view, is one tab stop, and opens its details", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  await book(alice, "2026-03-04", "2026-03-05");
  const row = alice.getByTestId("tl-m_alice");
  for (const v of ["Year", "Month", "Week"] as const) {
    await view(alice, v).click();
    await expect(row.locator(".d.vacation"), v).toHaveCount(2);
    await expect(row.locator('.d[role="button"]'), v).toHaveCount(1);
  }
  // week cells carry a label once per run
  await expect(row.locator(".lbl")).toHaveText(["Vacation"]);
  await row.locator('.d[role="button"]').click();
  const dlg = alice.getByRole("dialog", { name: "Leave details" });
  await expect(dlg).toContainText("4 Mar – 5 Mar 2026");
  await alice.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  // keyboard
  await row.locator('.d[role="button"]').focus();
  await alice.keyboard.press("Enter");
  await expect(dlg).toBeVisible();
  await expect(row.locator('.d[role="button"]')).toHaveAttribute("aria-label", /Alice Muster — Vacation, 4 Mar – 5 Mar 2026/);
});

test("each person gets a distinct colour badge with their initials", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  const ids = ["m_boss", "m_alice", "m_bob", "m_carol"];
  for (const id of ids) await expect(alice.getByTestId(`tl-badge-${id}`)).toBeVisible();
  await expect(alice.getByTestId("tl-badge-m_alice")).toHaveText("AM");
  await expect(alice.getByTestId("tl-badge-m_carol")).toHaveText("CR");
  const colours = await Promise.all(ids.map((id) => alice.getByTestId(`tl-badge-${id}`).evaluate((e) => getComputedStyle(e).backgroundColor)));
  expect(new Set(colours).size).toBe(ids.length);
  // the same colours for another viewer
  const bob = await openAs(context, "bob");
  await ready(bob);
  const bobs = await Promise.all(ids.map((id) => bob.getByTestId(`tl-badge-${id}`).evaluate((e) => getComputedStyle(e).backgroundColor)));
  expect(bobs).toEqual(colours);
  // and the viewer's own row is marked
  await expect(alice.getByTestId("tl-m_alice").locator(".tl-name")).toHaveClass(/\bme\b/);
});

test("a week across New Year shows leave from the archived year and opens it", async ({ context }) => {
  const rec = {
    id: "r_nye", ledgerKey: "u_alice", memberId: "m_alice", status: "approved", auto: true, note: "", createdBy: "m_alice",
    createdAt: "2025-11-01T00:00:00Z", decision: null, kind: "leave", type: "vacation", start: "2025-12-29", end: "2025-12-30",
    halfStart: false, halfEnd: false, halfPeriod: null,
  };
  const seed = teamSeed({
    "archive/2025": { year: 2025, hoursPerDay: 8.4, carry: {}, complete: true, at: "2026-01-10T00:00:00Z" },
    "archive/2025/ledgers/u_alice": { year: 2025, records: [rec] },
  });
  (seed["config/settings"] as Record<string, unknown>).archivedBefore = 2026;
  const alice = await openAs(context, "alice", { seed });
  await ready(alice);
  await view(alice, "Month").click();
  await alice.getByRole("button", { name: "Previous month" }).click();
  await alice.getByRole("button", { name: "Previous month" }).click();
  await expect(period(alice)).toHaveText("January 2026");
  await view(alice, "Week").click();
  await expect(period(alice)).toHaveText("29 Dec 2025 – 4 Jan 2026");
  await expect(alice.getByText("Week 1", { exact: true })).toBeVisible();
  const row = alice.getByTestId("tl-m_alice");
  await expect(row.locator(".d.vacation")).toHaveCount(2);
  await row.locator('.d[role="button"]').click();
  const dlg = alice.getByRole("dialog", { name: "Leave details" });
  await expect(dlg).toContainText("29 Dec – 30 Dec 2025");
  await expect(dlg).not.toContainText("no longer here");
});

test("on a phone the timeline starts on the month and never widens the page @phone", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  const phone = test.info().project.name === "phone";
  await expect(view(alice, phone ? "Month" : "Year")).toHaveAttribute("aria-pressed", "true");
  for (const v of ["Year", "Month", "Week"] as const) {
    await view(alice, v).click();
    await expect(view(alice, v)).toHaveAttribute("aria-pressed", "true");
    const overflow = await alice.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${v} view overflows the page`).toBeLessThanOrEqual(0);
  }
  // the week fits without scrolling sideways
  const wrap = alice.locator(".tl-wrap");
  expect(await wrap.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
});

test("half days and pending bookings are marked, and Space opens a booking", async ({ context }) => {
  const seed = teamSeed({
    "ledger/u_alice": { v: 2, entries: {
      half: entry("m_alice", "2026-03-04", "2026-03-04", { halfStart: true, halfPeriod: "am" }),
      long: entry("m_alice", "2026-03-16", "2026-03-20"), // over the 2-day threshold: awaiting approval
    } },
  });
  const alice = await openAs(context, "alice", { seed });
  await ready(alice);
  const row = alice.getByTestId("tl-m_alice");
  for (const v of ["Year", "Month"] as const) {
    await view(alice, v).click();
    await expect(row.locator(".d.pend"), v).toHaveCount(5);
    await expect(row.locator('.d[role="button"]', { has: alice.locator("xpath=self::*[contains(@aria-label,'(half day)')]") }), v).toHaveCount(1);
  }
  await view(alice, "Week").click();
  await expect(row.locator(".lbl")).toHaveText(["Vacation ½"]);
  const half = row.locator('.d[role="button"]');
  await expect(half).toHaveAttribute("aria-label", /\(half day\)/);
  await alice.getByRole("button", { name: "Next week" }).click();
  await alice.getByRole("button", { name: "Next week" }).click();
  await expect(period(alice)).toHaveText("16 Mar – 22 Mar 2026");
  await expect(row.locator(".d.pend")).toHaveCount(5);
  const pending = row.locator('.d[role="button"]');
  await expect(pending).toHaveAttribute("aria-label", /\(awaiting approval\)/);
  // Space opens the booking and doesn't scroll the page (needs a page that can scroll)
  await alice.setViewportSize({ width: 1280, height: 400 });
  expect(await alice.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
  await pending.focus();
  const y0 = await alice.evaluate(() => window.scrollY);
  await alice.keyboard.press(" ");
  await expect(alice.getByRole("dialog", { name: "Leave details" })).toContainText("16 Mar – 20 Mar 2026");
  await alice.waitForTimeout(200);
  expect(await alice.evaluate(() => window.scrollY)).toBe(y0);
});

test("week arrows cross New Year into the next year", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  await view(alice, "Month").click();
  for (let i = 0; i < 9; i++) await alice.getByRole("button", { name: "Next month" }).click();
  await expect(period(alice)).toHaveText("December 2026");
  await view(alice, "Week").click();
  await expect(period(alice)).toHaveText("30 Nov – 6 Dec 2026");
  for (let i = 0; i < 4; i++) await alice.getByRole("button", { name: "Next week" }).click();
  await expect(period(alice)).toHaveText("28 Dec 2026 – 3 Jan 2027");
  await expect(alice.getByText("Week 53", { exact: true })).toBeVisible();
  await alice.getByRole("button", { name: "Next week" }).click();
  await expect(period(alice)).toHaveText("4 Jan – 10 Jan 2027");
  await expect(alice.getByText("Week 1", { exact: true })).toBeVisible();
  await view(alice, "Month").click();
  await expect(period(alice)).toHaveText("January 2027");
  await view(alice, "Year").click();
  await expect(period(alice)).toHaveText("2027");
});

test("stepping back from New Year into an archived year keeps the archived leave", async ({ context }) => {
  const rec = {
    id: "r_nye", ledgerKey: "u_alice", memberId: "m_alice", status: "approved", auto: true, note: "", createdBy: "m_alice",
    createdAt: "2025-11-01T00:00:00Z", decision: null, kind: "leave", type: "vacation", start: "2025-12-29", end: "2025-12-30",
    halfStart: false, halfEnd: false, halfPeriod: null,
  };
  const seed = teamSeed({
    "archive/2025": { year: 2025, hoursPerDay: 8.4, carry: {}, complete: true, at: "2026-01-10T00:00:00Z" },
    "archive/2025/ledgers/u_alice": { year: 2025, records: [rec] },
  });
  (seed["config/settings"] as Record<string, unknown>).archivedBefore = 2026;
  const alice = await openAs(context, "alice", { seed });
  await ready(alice);
  await view(alice, "Week").click();
  for (let i = 0; i < 9; i++) await alice.getByRole("button", { name: "Previous week" }).click();
  await expect(period(alice)).toHaveText("29 Dec 2025 – 4 Jan 2026");
  const row = alice.getByTestId("tl-m_alice");
  await expect(row.locator(".d.vacation")).toHaveCount(2);
  await alice.getByRole("button", { name: "Previous week" }).click();
  await expect(period(alice)).toHaveText("22 Dec – 28 Dec 2025");
  await view(alice, "Year").click();
  await expect(period(alice)).toHaveText("2025");
  await expect(row.locator(".d.vacation")).toHaveCount(2);
  await view(alice, "Week").click();
  await alice.getByRole("button", { name: "Next week" }).click();
  await expect(row.locator(".d.vacation")).toHaveCount(2);
});

test("moving the Calendar tab's month moves the timeline's month and week", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  await tab(alice, "Calendar");
  await alice.getByRole("button", { name: "Next month" }).click();
  await alice.getByRole("button", { name: "Next month" }).click();
  await expect(alice.getByRole("heading", { name: "May 2026" })).toBeVisible();
  await tab(alice, "Timeline");
  await view(alice, "Month").click();
  await expect(period(alice)).toHaveText("May 2026");
  await view(alice, "Week").click();
  await expect(period(alice)).toHaveText("4 May – 10 May 2026");
});

test("a junk saved view falls back to the default @phone", async ({ context }) => {
  await context.addInitScript(() => { try { localStorage.setItem("smpleave:tlView", "decade"); } catch { /* */ } });
  const alice = await openAs(context, "alice");
  await ready(alice);
  const phone = test.info().project.name === "phone";
  await expect(view(alice, phone ? "Month" : "Year")).toHaveAttribute("aria-pressed", "true");
  await expect(period(alice)).toHaveText(phone ? "March 2026" : "2026");
});

test("the year and month views keep today in sight on a phone @phone", async ({ context }) => {
  test.skip(test.info().project.name !== "phone", "needs a narrow screen");
  const alice = await openAs(context, "alice");
  await ready(alice);
  const wrap = alice.locator(".tl-wrap");
  await view(alice, "Year").click();
  await expect.poll(() => wrap.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
  const first = await wrap.evaluate((e) => e.scrollLeft);
  await wrap.evaluate((e) => { e.scrollLeft = 3000; });
  await alice.getByRole("button", { name: "Today", exact: true }).click();
  await expect.poll(() => wrap.evaluate((e) => e.scrollLeft)).toBe(first);
  // today's cell is inside the visible area, right of the sticky names
  const visible = await alice.evaluate(() => {
    const w = document.querySelector(".tl-wrap")!.getBoundingClientRect();
    const c = document.querySelector(".tl-days .d.is-today")!.getBoundingClientRect();
    const n = document.querySelector(".tl-name")!.getBoundingClientRect();
    return c.left >= n.right && c.right <= w.right;
  });
  expect(visible).toBe(true);
  await view(alice, "Week").click();
  await expect.poll(() => wrap.evaluate((e) => e.scrollLeft)).toBe(0);
});

test("a dialog never steals focus from a field already being typed in", async ({ context }) => {
  // what fill() does for a number input: focus + select, then a separate insertText; the dialog's
  // delayed autofocus used to fire in between and swallow the hours (seen once under load)
  const alice = await openAs(context, "alice");
  await ready(alice);
  // open the dialog and move into the hours field in one go, before its 30 ms autofocus timer fires
  const focused = await alice.evaluate(async () => {
    const appeared = new Promise<HTMLInputElement>((resolve) => {
      const mo = new MutationObserver(() => {
        const el = document.querySelector<HTMLInputElement>("#ot-hours");
        if (el) { mo.disconnect(); resolve(el); }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    });
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Log overtime")!.click();
    const hours = await appeared;
    hours.focus();
    hours.select();
    await new Promise((r) => setTimeout(r, 120));
    return document.activeElement?.id;
  });
  expect(focused).toBe("ot-hours");
  await alice.keyboard.insertText("8.4");
  await expect(alice.getByRole("dialog", { name: "Log overtime" }).locator("#ot-hours")).toHaveValue("8.4");
});

test("a booking opened from the keyboard moves focus into the dialog", async ({ context }) => {
  const seed = teamSeed({ "ledger/u_bob": { v: 2, entries: { b1: entry("m_bob", "2026-03-04", "2026-03-04") } } });
  const alice = await openAs(context, "alice", { seed });
  await ready(alice);
  await alice.getByTestId("tl-m_bob").locator('.d[role="button"]').focus();
  await alice.keyboard.press("Enter");
  const dlg = alice.getByRole("dialog", { name: "Leave details" });
  await expect(dlg).toBeVisible();
  await expect.poll(() => dlg.evaluate((e) => e.contains(document.activeElement))).toBe(true);
});
