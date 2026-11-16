import { expect, test } from "@playwright/test";
import { book, openAs, ready, storeDump, tab, teamSeed } from "./fixtures";

test("first run: an Editor creates the team", async ({ context }) => {
  const boss = await openAs(context, "boss", { seed: null });
  await expect(boss.getByRole("heading", { name: "Set up leave tracking" })).toBeVisible();
  await boss.getByLabel("Person 2").fill("Anja Brunner");
  await boss.getByRole("button", { name: "Create the team" }).click();
  await ready(boss);
  await expect(boss.locator("#whoami")).toContainText("Bea Boss");
  await tab(boss, "Team");
  await expect(boss.locator(".mrow", { hasText: "Anja Brunner" })).toBeVisible();
});

test("a Contributor on an empty tracker is told to ask the owner", async ({ context }) => {
  const alice = await openAs(context, "alice", { seed: null });
  await expect(alice.locator(".gate")).toContainText("Ask whoever owns this tracker");
});

test("someone added by name picks themself and can book", async ({ context }) => {
  const carol = await openAs(context, "carol");
  await expect(carol.getByRole("heading", { name: "Which one are you?" })).toBeVisible();
  await carol.locator(".mrow", { hasText: "Carol Roth" }).getByRole("button", { name: "That’s me" }).click();
  await ready(carol);
  await expect(carol.getByTestId("unbound-banner")).toHaveCount(0);
  await book(carol, "2026-03-04", "2026-03-04");
  await tab(carol, "Requests");
  await expect(carol.locator(".req", { hasText: "4 Mar 2026" })).toContainText("Logged");
  // an approver's page confirms the uncontested claim
  const boss = await openAs(context, "boss");
  await ready(boss);
  await expect.poll(async () => (await storeDump(boss))["members/m_carol"]!.data.uid, { timeout: 8000 }).toBe("u_carol");
});

test("someone not on the roster asks to join and an Editor adds them", async ({ context }) => {
  const nina = await openAs(context, "nina");
  await nina.getByRole("button", { name: "Ask to be added" }).click();
  await expect(nina.getByRole("heading", { name: "Waiting to be added" })).toBeVisible();
  const boss = await openAs(context, "boss");
  await ready(boss);
  await expect(boss.locator("#tabs button", { hasText: "Team" }).locator(".badge")).toHaveText("1");
  await tab(boss, "Team");
  await boss.locator(".mrow", { hasText: "Nina Neu" }).getByRole("button", { name: "Add to the team" }).click();
  await expect(nina.locator("#whoami")).toHaveText("Nina Neu");
});

test("directory-added people show their Claude name everywhere (v1 showed blanks)", async ({ context }) => {
  const boss = await openAs(context, "boss");
  await ready(boss);
  await tab(boss, "Balances");
  await expect(boss.getByTestId("balances")).toContainText("Alice Muster");
  await expect(boss.getByTestId("balances")).toContainText("Bob Keller");
  await tab(boss, "Timeline");
  await expect(boss.getByTestId("tl-m_alice")).toContainText("Alice Muster");
});

test("an Editor adds people by name and from the directory", async ({ context }) => {
  const boss = await openAs(context, "boss");
  await ready(boss);
  await tab(boss, "Team");
  await boss.getByRole("button", { name: "Add people" }).first().click();
  const dlg = boss.getByRole("dialog", { name: "Add people to the team" });
  await dlg.locator("#people-search").fill("Nina");
  await dlg.locator(".mrow", { hasText: "Nina Neu" }).getByRole("button", { name: "Add" }).click();
  await dlg.getByRole("button", { name: "By name" }).click();
  await dlg.locator("#people-names").fill("Pierre Chassot\nTomás Reyes");
  await dlg.getByRole("button", { name: "Add them" }).click();
  await dlg.getByRole("button", { name: "Done" }).click();
  for (const n of ["Nina Neu", "Pierre Chassot", "Tomás Reyes"]) await expect(boss.locator(".mrow", { hasText: n })).toBeVisible();
});

test("overtime: logged, approved, banked, then spent as time off in lieu", async ({ context }) => {
  const alice = await openAs(context, "alice");
  await ready(alice);
  await alice.getByRole("button", { name: "Log overtime" }).first().click();
  const dlg = alice.getByRole("dialog", { name: "Log overtime" });
  await dlg.locator("#ot-date").fill("2026-02-28");
  await dlg.locator("#ot-hours").fill("8.4");
  await dlg.getByRole("button", { name: "Send for approval" }).click();
  const boss = await openAs(context, "boss");
  await ready(boss);
  await tab(boss, "Requests");
  await boss.locator(".req", { hasText: "28 Feb 2026" }).getByRole("button", { name: "Approve" }).click();
  await tab(boss, "Balances");
  await expect(boss.getByTestId("overtime").locator("tr", { hasText: "Alice" })).toContainText("8.4 h");
  await book(alice, "2026-03-06", "2026-03-06", { type: "In lieu" });
  await tab(alice, "Balances");
  await expect(alice.getByTestId("overtime").locator("tr", { hasText: "Alice" }).locator("td").nth(4)).toHaveText("0 h");
});

test("CSV export goes through the downloads capability in v1's layout", async ({ context }) => {
  const boss = await openAs(context, "boss");
  await ready(boss);
  await book(boss, "2026-03-04", "2026-03-04");
  await tab(boss, "Balances");
  await boss.getByRole("button", { name: "Export CSV" }).click();
  await expect(boss.locator(".toast").last()).toHaveText("Saved");
  const saved = await boss.evaluate(() => (window as unknown as { __fake: { saved: { filename: string; data: string }[] } }).__fake.saved);
  expect(saved[0]!.filename).toBe("leave-smp-physics-team-2026.csv");
  expect(saved[0]!.data.startsWith("﻿Person,Type,Start,End,Days,Status,Note,Decided by,Requested\r\n")).toBe(true);
  expect(saved[0]!.data).toContain("Bea Boss,Vacation,2026-03-04,2026-03-04,1,approved");
});

test("archiving an old year keeps it viewable and the overtime bank intact", async ({ context }) => {
  const e = (kind: string, extra: Record<string, unknown>) => ({ kind, memberId: "m_alice", note: "", createdBy: "m_alice", createdAt: "2024-01-01T00:00:00Z", withdrawnAt: null, withdrawnBy: null, ...extra });
  const seed = teamSeed({
    "ledger/u_alice": { v: 2, entries: {
      old: e("leave", { type: "vacation", start: "2024-07-01", end: "2024-07-05", halfStart: false, halfEnd: false, halfPeriod: null }),
      ot: e("overtime", { date: "2024-03-02", hours: 10 }),
    } },
    "decisions/u_alice": { v: 2, items: {
      old: { status: "approved", by: "m_boss", at: "2024-06-01T00:00:00Z", note: "", fp: "u_alice|leave|m_alice|vacation|2024-07-01|2024-07-05|0|0||||", grandfathered: false, snapshot: { kind: "leave", memberId: "m_alice", type: "vacation", start: "2024-07-01", end: "2024-07-05", halfStart: false, halfEnd: false } },
      ot: { status: "approved", by: "m_boss", at: "2024-03-05T00:00:00Z", note: "", fp: "u_alice|overtime|m_alice|||||0|0||2024-03-02|10", grandfathered: false, snapshot: { kind: "overtime", memberId: "m_alice", date: "2024-03-02", hours: 10 } },
    } },
  });
  const boss = await openAs(context, "boss", { seed });
  await ready(boss);
  await tab(boss, "Balances");
  await expect(boss.getByTestId("overtime").locator("tr", { hasText: "Alice" }).locator("td").nth(4)).toHaveText("10 h");
  await tab(boss, "Settings");
  await boss.getByRole("button", { name: "Archive 2024" }).click();
  await boss.getByRole("dialog").getByRole("button", { name: "Archive 2024" }).click();
  await expect(boss.locator(".toast").last()).toHaveText("Archived 2024");
  const db = await storeDump(boss);
  expect((db["ledger/u_alice"]!.data.entries as Record<string, unknown>).old).toBeNull();
  expect(db["config/settings"]!.data.archivedBefore).toBe(2025);
  expect(db["archive/2024"]!.data.complete).toBe(true);
  // the bank still has the archived hours
  await tab(boss, "Balances");
  await expect(boss.getByTestId("overtime").locator("tr", { hasText: "Alice" }).locator("td").nth(4)).toHaveText("10 h");
  // 2024 still shows Alice's week off
  await boss.getByRole("combobox", { name: "Year" }).selectOption("2024");
  await expect(boss.getByTestId("balances").locator("tr", { hasText: "Alice" }).locator("td").nth(3)).toHaveText("5");
});
