import { expect, type BrowserContext, type Page } from "@playwright/test";
import { RULES } from "../../src/platform/capabilities";
import { installFakeClaude, type FakeArg, type FakeViewer } from "../fake/runtime";

/** A fixed "today": Monday 2 March 2026, 09:00 local time. */
export const TODAY = "2026-03-02T09:00:00";

export const DIRECTORY = [
  { id: "u_boss", name: "Bea Boss", email: "bea@example.org" },
  { id: "u_alice", name: "Alice Muster", email: "alice@example.org" },
  { id: "u_bob", name: "Bob Keller", email: "bob@example.org" },
  { id: "u_carol", name: "Carol Roth", email: "carol@example.org" },
  { id: "u_mallory", name: "Mallory Blum", email: "mallory@example.org" },
  { id: "u_new", name: "Nina Neu", email: "nina@example.org" },
];

export const VIEWERS: Record<string, FakeViewer> = {
  boss: { uid: "u_boss", name: "Bea Boss", level: "admin" },
  owner: { uid: "u_owner", name: "Olga Owner", level: "owner" },
  alice: { uid: "u_alice", name: "Alice Muster", level: "interact" },
  bob: { uid: "u_bob", name: "Bob Keller", level: "interact" },
  carol: { uid: "u_carol", name: "Carol Roth", level: "interact" },
  mallory: { uid: "u_mallory", name: "Mallory Blum", level: "interact" },
  nina: { uid: "u_new", name: "Nina Neu", level: "interact" },
  viewer: { uid: "u_bob", name: "Bob Keller", level: "view" },
  /** a visitor from outside the organisation: view level, and can() says nothing */
  outsider: { uid: "u_carol", name: "Carol Roth", level: "view" },
};

const member = (uid: string | null, role = "member", name = "") => ({
  name, nameHint: "", uid, role, entitlements: {}, carryover: {}, archived: false, keepUnresolved: false,
  source: uid ? "directory" : "manual", addedAt: "2026-01-01T00:00:00.000Z", leftAt: null,
});

/** A team: Bea approves (Editor), Alice and Bob are Contributors, Carol was typed in by name. */
export function teamSeed(extra: Record<string, Record<string, unknown>> = {}): Record<string, Record<string, unknown>> {
  return {
    "config/settings": {
      teamName: "SMP Physics Team", defaultDays: 25, workdays: [1, 2, 3, 4, 5], approvalThreshold: 2, hoursPerDay: 8.4,
      holidays: ["newyear", "goodfriday", "ascension", "corpuschristi", "nationalday", "assumption", "allsaints", "immaculate", "christmas", "berchtold", "eastermonday", "labour", "whitmonday", "dec24", "ststephen", "dec31"],
      customHolidays: [], yearEnd: {}, created: "2026-01-01T00:00:00.000Z", holidayVersion: 2,
    },
    "members/m_boss": member("u_boss", "manager"),
    "members/m_alice": member("u_alice"),
    "members/m_bob": member("u_bob"),
    "members/m_carol": member(null, "member", "Carol Roth"),
    ...extra,
  };
}

export interface OpenOpts {
  seed?: Record<string, Record<string, unknown>> | null;
  canWrite?: boolean | null;
  disable?: FakeArg["disable"];
  memberPref?: string;
  path?: string;
  cacheFirst?: "same" | "empty";
  latencyMs?: number;
  /** remove window.claude entirely (a page opened outside claude.ai) */
  noRuntime?: boolean;
}

/** Open the page as someone. Pages in one context share the fake store, like viewers of one artifact. */
export async function openAs(context: BrowserContext, who: keyof typeof VIEWERS | null, opts: OpenOpts = {}): Promise<Page> {
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(TODAY));
  const arg: FakeArg = {
    viewer: who ? VIEWERS[who]! : null,
    rules: [...RULES],
    directory: DIRECTORY,
    seed: opts.seed === undefined ? teamSeed() : opts.seed,
    disable: opts.disable,
    canWrite: opts.canWrite,
    cacheFirst: opts.cacheFirst,
    latencyMs: opts.latencyMs,
  };
  if (!opts.noRuntime) await page.addInitScript(installFakeClaude, arg);
  if (opts.memberPref) {
    await page.addInitScript((m) => { try { localStorage.setItem("smpleave:memberId", m); } catch { /* */ } }, opts.memberPref);
  }
  page.on("pageerror", (e) => { throw e; });
  await page.goto(opts.path ?? "/");
  return page;
}

export async function ready(page: Page) {
  await expect(page.locator("#tabs button").first()).toBeVisible();
}

export async function tab(page: Page, name: string) {
  await page.locator("#tabs button", { hasText: name }).click();
}

export async function book(page: Page, from: string, to: string, opts: { type?: string; note?: string } = {}) {
  await page.getByRole("button", { name: "Book leave" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Book time away" });
  if (opts.type) await dlg.getByRole("button", { name: opts.type, exact: true }).click();
  await dlg.locator("#book-from").fill(from);
  await dlg.locator("#book-to").fill(to);
  if (opts.note) await dlg.locator("#book-note").fill(opts.note);
  await dlg.locator(".ft .btn.primary").click();
  await expect(dlg).toBeHidden();
}

/** Raw store contents (from the page's localStorage). */
export async function storeDump(page: Page): Promise<Record<string, { data: Record<string, unknown> }>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("fake-claude-db") || "{}"));
}
