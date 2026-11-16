# Testing

## What runs

- **Unit (Vitest, `test/unit`)**: Easter and the Fribourg calendar (2024–2028, half
  days, published year-end table, custom closures); working-day counting (weekends,
  holidays, half-day caps, cross-year); identity bindings (pinned, uncontested,
  contested); effective status (auto-approval on contiguous runs, decisions,
  edits after decision, deleted entries, withdrawals, sealing, threshold drops);
  balances and the overtime bank incl. archived carry; parsers dropping junk and
  archive `null`s; v1 → v2 migration (statuses, idempotency, back-port round
  trip); the access-rules declaration against the publish constraints; the fake
  rule engine at view / interact / admin / owner.
- **E2E (Playwright, `test/e2e`)**: the built `dist/artifact.html`, wrapped the way
  claude.ai wraps it, against `test/fake/runtime.ts`. Several pages in one browser
  context share the fake store, so a Contributor tab and an Editor tab see each
  other's writes live. "Today" is fixed to Mon 2 March 2026. Projects: Zurich (all
  tests), Pacific/Auckland and America/Los_Angeles (tagged `@tz`), Pixel 7 (`@phone`).
  - Book leave stays enabled for regular Contributors, and stays enabled after a
    refused write (the v1 bug).
  - Booking, half days, holidays, cancel; approval queue and live update; decline
    with a note; threshold splitting; sealing survives an entry deleted via devtools.
  - Attacks via raw `window.claude` calls: decisions / roster / settings / other
    ledgers / other links refused; entries booked under another name ignored;
    an approved booking edited later keeps its approved version; two accounts
    claiming one name bind nobody until an Editor picks.
  - First run, ask to join, "That's me", directory and by-name import, overtime
    bank, CSV export layout, archiving a year, read-only viewer, page outside claude.ai.
  - The page loads with every network request blocked except Google Fonts.
  - At most 8 live subscriptions after visiting every tab.
  - **Parity oracle**: the real v1 page and v2 render identical Balances, Overtime
    and Days-off tables from the same data (v1 documents vs. their migration), for
    2026 and 2027.

## What the tests cannot prove

The fake runtime is our reading of the platform contract (`db.d.ts`, `user.d.ts`,
runtime 0.2.89). A misreading would pass in both the app and the fake. It does not model:

- real network latency patterns, reconnects, `unavailable`, or snapshot ordering
  beyond "cached first, then definitive";
- rate limits, the 25,000-document cap, or organisation quotas (only the 256 KiB
  document size is checked);
- `revoked` mid-session, consent prompts, or the downloads confirmation dialog;
- leases across pages (each page has its own lease table);
- the real directory (`search` is a fixed list) or profile resolution rules;
- the sandboxed iframe and CSP the page really runs in.

Those are covered by the staging check: publish to a separate artifact, read back
with `ArtifactData` at `as_level` view / interact, and open it in a browser.

## Known residual gaps (by design, documented in the app's About panel)

- An entry created and deleted before any approver opens the page leaves no record.
- A one-working-day gap still splits an approval run.
- Editors can technically write their own decisions; the "not your own unless
  you're the only approver" rule is enforced in the page only.
- Everyone who can open the artifact sees sick leave (as in v1).
