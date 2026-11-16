# SMP Physics Team — Leave (v2)

The team's leave and absence tracker, hosted as a claude.ai artifact
(link shared privately within the team). Vite + React + TypeScript,
built into one self-contained HTML page. There is no server: the artifact's
built-in database is the backend, and its **access rules** are the
authorization layer (`src/platform/capabilities.ts`).

## Requirements

Node 26 (see `.nvmrc`). Node was installed for this user at `~/.local/opt/node`;
add it to your PATH with `export PATH=$HOME/.local/opt/node/bin:$PATH`.

```sh
npm install
npx playwright install chromium   # once, for the e2e tests
```

## Commands

| command | what it does |
|---|---|
| `npm run typecheck` | TypeScript, strict |
| `npm test` | unit tests (Vitest): domain logic, rules engine, migration |
| `npm run build` | `dist/artifact.html` (publish this) and `dist/capabilities.json` |
| `npm run e2e` | Playwright against the built page and a fake `window.claude` |
| `npm run check` | all of the above, in order |

## Layout

```
src/domain/     pure logic: dates, Fribourg holidays, day counting, records, status, balances, CSV
src/platform/   runtime types, capabilities + access rules, parsers for stored data, v1 migration
src/state/      store (useSyncExternalStore), subscriptions (started once, outside React), all writes
src/ui/         React views and dialogs; styles carried over from v1 unchanged
test/unit/      Vitest
test/e2e/       Playwright specs, a server that wraps the page like claude.ai does
test/fake/      in-memory window.claude that enforces the published access rules
test/fixtures/  v1 page, used as a parity oracle
```

## Data model

```
config/settings              Editors only
members/{memberId}           Editors only
ledger/{uid}                 a person's own bookings; only they (and Editors) write it
ledger/{memberId}            bookings an Editor entered for someone; Editors only
decisions/{ledgerKey}        approvals, declines, cancellations, automatic seals; Editors only
archive/{year}[/ledgers/*]   archived years; Editors only
links/{uid}                  "that's me" claims; each person writes only their own
joiners/{uid}                join requests; private to the asker, visible to Editors
data/users/{uid}/profile     private per viewer
requests/*, overtime/*       v1 data, untouched, frozen (rollback backup)
```

Statuses are derived on every viewer's machine from the bookings, the
decisions and the settings, so they can't be forged by editing a status
field. See `PLAN.md` §5b–5c for the reasoning and the reviewers' findings.

## Who can do what

- **Contributor** (share menu): books and cancels their own upcoming leave, logs overtime.
- **Editor / Owner**: approves and declines, cancels anyone's leave, records time for
  someone else, edits roster and settings, archives years. **Approvers need Editor access.**
- **Viewer / Commenter**: reads everything, books nothing (the page says so).

## Publishing

1. `npm run check` (all green).
2. Publish `dist/artifact.html` to the tracker's artifact with the capabilities in
   `dist/capabilities.json`.
3. Migration from v1 is idempotent (`src/platform/migrate.ts`, v1 ids are kept);
   rollback = republish the v1 page with its old capabilities and, if v2 bookings
   must be kept, write them back with `backportToV1`.
