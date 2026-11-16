# SMP Leave tracker — v2 rewrite plan

Rewrite of the team's claude.ai leave-tracker artifact
(currently one 2,521-line vanilla-JS HTML file) as a Vite + React + TypeScript
app, still hosted as a claude.ai artifact, with the artifact's built-in `db`
capability as the backend and its **access rules** as the server-side
authorization layer.

## 0. Constraints that shape everything

Platform facts (runtime contract 0.2.89, `db.d.ts` / `user.d.ts`):

- No server code. The page is static HTML; `window.claude.use("db" | "user" | "downloads")`
  are the only "backend" calls.
- `db`: Firestore-like document store. `doc/collection/get/set/update/delete/onSnapshot`,
  `where` (≤10), one `orderBy`, `limit` ≤ 1000. **No indexes** (scans; keep queried
  collections to hundreds–low thousands), **no transactions** (last writer wins; nested
  objects in `update` merge recursively), 256 KiB per doc, 25,000 docs per artifact,
  64 live subscriptions per view.
- Access rules are declared at publish, path-based, keyed only on the viewer's
  sharing level: `view` < `interact` (Contributor) < `admin` (Editor / granted Owner) < `owner`.
  `{self}` as the last segment of a rule path = the viewer's own subtree (doc id = their user id).
  A rule at the prefix of a `{self}` rule must set both `read` and `write`. Max 64 rules.
  Rules cannot reference document contents or app roles.
- `user`: `id()`, `me()`, `can("data.write")`, `canEdit()` (= admin), `profiles(ids)`, `search(q)`.
- Single-file output is simplest to publish: Vite builds to one self-contained `index.html`
  (`vite-plugin-singlefile`); only the Google Fonts stylesheet stays external (allowed).

Live data today (backed up locally, not committed): 1 settings doc, 6 members, 2 requests,
0 overtime, 1 link, 0 joiners.

## 1. Goals

1. **Feature parity** with v1: first-run setup; identity picker ("That's me", ask to be
   added, add self); Timeline (today strip + year grid); month Calendar; Requests ledger with
   filters; Balances (vacation, overtime bank, days off list); Team (roster, entitlements,
   carry-over, approvers, archive/restore, rename, add by name / from Claude directory /
   directory sweep, join queue, leaver detection); Settings (team, days, threshold, hours/day,
   workdays, Fribourg holidays incl. 24/31 Dec per year, custom closures); booking modal with
   half days and live calculation; overtime logging; approve / decline with note; cancel;
   CSV export; read-only mode; light/dark theme identical to v1's tokens.
2. **Integrity enforced by the platform, not the page** (fixes v1's "anyone can approve their
   own leave via devtools"):
   - A person can only write their *own* leave and overtime.
   - Only Editors (admin) can record approvals/declines, change roster or settings.
   - Editing an approved request after approval invalidates the approval (fingerprint).
   - Auto-approval below the threshold is *derived* on every client from the dates, not trusted
     from a stored flag.
3. **Scalability** within platform limits: no "first 1,000 of everything"; bounded document
   sizes; per-year archiving that actually exists; ≤ ~10 live subscriptions.
4. **Tests**: unit tests for all domain logic (Vitest), component tests where useful, and
   Playwright e2e tests driving the built single-file page against an in-memory fake of
   `window.claude` that **enforces the same access-rules declaration we publish**.
5. Git-tracked source in this folder. Built `dist/index.html` is what gets published.

Non-goals: SQL, Express/Hono (not runnable in an artifact — agreed with the user), email
notifications, multi-team support.

## 2. Data model v2

```
config/settings                 admin-write   (unchanged shape + archivedBefore, thresholdChanges)
members/{memberId}              admin-write   (unchanged shape + overtimeCarry)
links/{uid}                     each viewer writes only their own  {memberId, at}
joiners/{uid}                   each viewer writes/reads own; admins read all
ledger/{key}                    key = the member's Claude user id (uid) when linked, else memberId
  { v: 2, entries: { [entryId]: Entry } }     owner of uid writes own; admins write all
ledger/{key}/archive/{year}     { v: 2, year, entries: {...} }   same rule (inherited)
decisions/{year}                admin-write   { items: { [entryId]: Decision } }   year = entry start year
data/users/{uid}/profile        private per viewer {memberId}  (unchanged)
```

Legacy v1 collections `requests/*`, `overtime/*` are left untouched (become admin-only via the
root rule) as a rollback/backup.

### Entry (in a ledger, written by the person or an admin)
```ts
type LeaveEntry = {
  kind: "leave"; memberId; type: "vacation"|"comp"|"sick"|"remote";
  start; end;            // ISO yyyy-mm-dd
  halfStart; halfEnd; halfPeriod: "am"|"pm"|null;
  note; createdBy /*memberId*/; createdAt;
  withdrawnAt?: string|null;  // the person cancelled it themself
}
type OvertimeEntry = { kind: "overtime"; memberId; date; hours; note; createdBy; createdAt; withdrawnAt? }
```
Writes use `update({entries: {[id]: entry}})` (recursive merge → one entry at a time, no
whole-doc rewrites, concurrent tabs don't clobber each other); `set` only when creating the
ledger doc.

### Decision (in `decisions/{year}`, admin only)
```ts
type Decision = { status: "approved"|"rejected"|"cancelled"; by /*memberId*/; at; note;
                  fp: string /* fingerprint of the entry fields that matter */; snapshot: {...} }
```
`snapshot` keeps member/type/dates/hours so the decided history survives even if a person
deletes their own entry with devtools.

### Effective status (pure function, `domain/status.ts`)
```
withdrawn            -> "cancelled"
decision exists and decision.fp === fp(entry) -> decision.status
leave: !needsApproval(entry, settings)  -> "approved" (auto, shown as "Logged")
otherwise            -> "pending"
```
- `needsApproval`: vacation/comp longer than `approvalThreshold` working days; overtime always.
- Lowering the threshold in Settings would turn old auto-booked entries into "pending";
  to avoid that, the Settings save (admin client) first writes `approved` decisions
  ("grandfathered") for every currently auto-approved entry that would flip.
- Entry validity: an entry in `ledger/{key}` is only accepted if `key === entry.memberId`
  (admin-written) or `key === uidOf(member(entry.memberId))`. Anything else is ignored and
  surfaced to admins in Team as "ignored entries" — prevents booking under someone else's name.

### Identity binding
- `members.uid` (set by an admin) wins.
- Otherwise `links/{uid}` → memberId claims an *unlinked* member; first claim by `at` wins if
  two accounts claim the same member; admins see claims and can pin `members.uid`.

### Archiving (the "archive old years" that v1 promised but never had)
- Admin action in Settings: "Archive years before Y". For each ledger: copy entries with
  `end` year < Y into `ledger/{key}/archive/{year}` docs, then `set` the ledger without them.
  Overtime hours approved in archived years are folded into `members/{id}.overtimeCarry`
  so the cumulative bank stays correct. `settings.archivedBefore = Y`.
- Viewing a year < archivedBefore loads the archive docs on demand with one-shot `get`s.
- Live load is bounded by "non-archived years", not by an arbitrary 1,000 cap.

### Subscriptions (per view)
`config/settings`, `members`, `links`, `ledger` (all ledgers, one doc per person), `decisions`
(one doc per year), `joiners` (admins only) → 6 live subscriptions regardless of team size.

## 3. Access rules (published declaration; single source `src/platform/capabilities.ts`)
```ts
db: { rules: [
  { path: "",                 read: "view",     write: "admin" },
  { path: "ledger",           read: "view",     write: "admin" },
  { path: "ledger/{self}",                       write: "interact" },
  { path: "links",            read: "view",     write: "admin" },
  { path: "links/{self}",                        write: "interact" },
  { path: "joiners",          read: "admin",    write: "admin" },
  { path: "joiners/{self}",   read: "interact", write: "interact" },
  { path: "data/users/{self}",                   write: "interact" },
] },
user: { scopes: ["profile"] },
downloads: {}
```
Consequence the team must know: **approvers need Editor access** in the share menu
(Contributors can book, can't approve). The UI shows approve controls only to admins and
warns in Team when an approver-role member can't approve.

## 4. Architecture

```
src/
  domain/        pure TS, no React, no platform: dates, holidays (Fribourg), counting,
                 balances, overtime bank, status, fingerprint, validation, csv, ids
  platform/      claude runtime adapter: types (subset of db.d.ts/user.d.ts), capabilities.ts
                 (rules), backend.ts (Backend interface), claudeBackend.ts (db impl),
                 migrations (v1 → v2 pure mapping)
  state/         store (useSyncExternalStore), selectors, actions (all writes go through
                 one `write()` with v1's error-code → toast mapping)
  ui/            React components: App, Header/Tabs, Toasts, Modal, views/{Timeline, Calendar,
                 Requests, Balances, Team, Settings, Setup, Identity}, dialogs/{Booking,
                 Overtime, RequestDetail, AddPeople, Import, Ask}
  styles.css     v1 tokens and classes, unchanged look
test/
  unit/          vitest: domain + migration + fake-db rule engine
  e2e/           playwright: built dist/index.html + fake runtime (init script)
  fake/          in-memory window.claude (db with rules engine from capabilities.ts, user, downloads)
```
- React: function components, no router, no state library (one store + selectors).
  Subscriptions live in one `useEffect` in the store bootstrap (subscribe once, per contract).
- Names are rendered via `textContent` semantics (React escapes) — no `dangerouslySetInnerHTML`.
- `localStorage` only for tab/year/memberId convenience (try/catch), as in v1.

## 5. Tests

Unit (Vitest):
- Easter + Fribourg holidays for 2025–2028 incl. half days, year-end table, custom closures.
- `countedDays/totalDays/daysInYear`: weekends, holidays, half-day caps, cross-year ranges.
- Balances, overtime bank (incl. carry from archive), status derivation (auto / pending /
  decided / fingerprint mismatch / withdrawn / threshold grandfathering).
- Entry validation (foreign ledger entries ignored), identity binding precedence.
- CSV escaping. v1→v2 migration mapping on fixture data shaped like the live data.
- Fake db rule engine: rules from `capabilities.ts` evaluated for view/interact/admin.

E2E (Playwright, chromium, against `vite build` output served by `vite preview`):
1. First run as admin: create team → roster appears, timeline renders.
2. Contributor picks identity, books 1 day vacation → "Logged", balance drops.
3. Contributor books 5 days → pending; admin view approves → approved, decision recorded.
4. Admin declines with a note → contributor sees "Declined" + note.
5. Contributor cancels upcoming leave → cancelled, days return.
6. Tamper: contributor writes a decision / another person's ledger via `window.claude` →
   rejected by the fake rule engine; contributor edits an approved entry → status back to pending.
7. Read-only viewer: book buttons disabled, no settings tab.
8. Overtime: log → admin approves → bank shows hours; comp leave draws it down.
9. CSV export calls `downloads.save` with expected header.
10. Archive years before Y → old year still viewable, bank unchanged.

## 5b. Revision after plan review (3 reviewers: APPROVE WITH CHANGES) — supersedes §2–§5 where they differ

**Rules (blocker: Contributors read-only).** `can("data.write")` answers for the *root* rule, so
the root stays `{read: "view", write: "interact"}` and every shared path gets an explicit lock:
```
""                 read view   write interact
config, members, decisions, archive, requests, overtime    write admin
ledger             read view   write admin      ledger/{self}  write interact
links              read view   write admin      links/{self}   write interact
joiners            read admin  write admin      joiners/{self} read interact write interact
data/users/{self}  write interact
```
A unit test checks the declaration against the publish constraints (≤64 rules, write ≥ read,
prefix rule sets both, `{self}` last) and that every collection the app touches is covered.
A refused admin-only write shows a toast; only a refused write to one's *own* ledger flips the
page read-only.

**Identity (blocker: link hijack).** Entry validity depends on a *binding*: `members.uid` (pinned
by an admin) wins; otherwise a link claim counts only if uncontested (exactly one `links/*` doc
claims that member) and that uid is not pinned to another member. Contested → nobody is bound
until an admin pins. Link `at` is never trusted for precedence. Admins see claims in Team with a
"Confirm" (pin) action. Joiners are accepted by doc id (= uid), never the body's `uid`.

**History (blocker: erasing past leave).** Ledger entries are immutable after creation except
for withdrawal; there is no edit UI. Admin clients *seal* self-booked, auto-approved entries:
a debounced pass (only on definitive, non-cache snapshots, only when something is unsealed)
writes `{status: approved, auto: true, snapshot}` decisions. Once any decision exists the
decision's snapshot is the record of what was booked: an entry deleted or altered afterwards
still counts as decided, and admins see a "changed after decision" flag. A person may withdraw
their own entry only before its start date (v1 allowed until the end date; ongoing leave is now
cancelled by an approver). Admin cancellation is a `cancelled` decision.
Threshold splitting is closed: approval is judged on the contiguous run of the person's
vacation/comp entries (joined across weekends/closures), not the single entry.
Settings saves (threshold, workdays, holidays, closures, hours) seal everything first, so a
settings change never flips a past status; `createdAt` is never used for authorization.

**Decisions per person (blocker: size).** `decisions/{ledgerKey}` = `{items: {[entryId]: Decision}}`,
fingerprint covers ledgerKey, kind, memberId, type, dates, halves, hours. One subscription to
the `decisions` collection (one doc per person).

**Admin-entered leave** is written to `ledger/{memberId}` (writable only by admins), so a person
cannot delete what an approver recorded for them. MemberIds keep the `m_` prefix (never collide
with `u_` user ids).

**Archive (blocker: safe re-run).** Admin-only path `archive/{year}` (summary: per-member
`{earnedH, spentH}`, hoursPerDay) and `archive/{year}/ledgers/{key}` (resolved records: entry +
decision + status). Year = entry end year. Sequence per year Y, under an `acquire` lease on
`config/archive`: write archive docs (absolute values, idempotent) → `get` to verify →
`settings.archivedBefore = Y+1` → null out live entries/decisions with `update({entries:{[id]: null}})`.
Balances and the overtime bank ignore live records with end year < archivedBefore, so a
half-finished run never double counts. Viewing year X < archivedBefore loads `archive/X` and
`archive/X+1` ledgers with one-shot `get`s. Bookings ending in an archived year are refused in
the UI and ignored in totals.

**Writes.** Ledger creation: `acquire` lease → `get` → `set` only if missing → `update`. Every
entry/decision write is the complete object with explicit nulls (nested merge would otherwise
mix fields). Notes ≤ 500 chars; serialized doc size checked before write, admins warned from
~150 KiB; `quota_exceeded` / size errors surfaced.

**Parity items now explicit.** Book / log overtime on someone's behalf (admins only, see above);
manager "Remove overtime" (→ `cancelled` decision); Today + month stepping changes year;
scroll-to-today only on mount/year change; both legends; CSV BOM / quoting / filename; use the
resolved display name everywhere (v1 rendered blank names for directory-added people — fixed);
the one-off holidayVersion migration is dropped (live data already at v2); joiners: admins
subscribe to the collection, everyone else to their own `joiners/{uid}` doc. Approve controls
require Editor; v1's self-approval rule kept (only if sole approver or owner); the "approver"
role remains as the label that marks who decides.

**Store.** Subscriptions start in `main.tsx` outside React (StrictMode-safe); `getSnapshot`
returns a cached immutable object; derived data memoized per snapshot; `profiles()` resolved in
an effect keyed on the sorted id list.

**Tests added.** Fixed clock + timezones (Pacific/Auckland, America/Los_Angeles); half-day and
cross-year cases; identity / join / directory e2e; link-hijack and history-erasure attacks;
subscription count; network blocked except fonts (proves single-file); `use()` → null and
read-only paths; **v1 as an oracle**: seed v1 data, run the real v1 page on the same fake, run v2
on the migrated data, compare Balances/Overtime/Days-off tables. The fake now delivers snapshots
asynchronously with a `fromCache` first delivery. TESTING.md lists what the fake cannot prove.

**Migration/rollback.** Publish v2, then migrate idempotently (v1 doc id = v2 entry id, so it can
be re-run to pick up writes from stale v1 tabs). v1 `cancelled`/`rejected`/manual `approved` →
decisions; v1 auto-approved → sealed decisions. A pure `v2 → v1` back-port function (unit-tested)
makes rollback lossless.

### 5c. Second security pass (no blockers) — adopted
- Withdrawal is judged on the viewer's clock (`today < start`), never on the client-written
  `withdrawnAt`. Before the start it shows as cancelled; an approver's client seals it as a
  `cancelled` decision. After the start without a seal it counts as taken and shows
  "withdrawal awaiting confirmation" until an approver cancels it.
- The approver's sealing pass auto-pins an uncontested link claim (`members.uid`) only when the
  claiming account's profile name matches the roster name (`claimLooksRight`); any other claim
  stays unconfirmed and Team asks an Editor to Confirm or Unlink it, showing the account's name.
  Unlink removes every claim on the entry and cancels what that account booked under the name.
- A viewer whose claim is refused (can() said nothing, the write says no) sees the tracker
  read-only with their pick highlighted, as in v1, instead of being kept out.
- Known residual gaps, documented in TESTING.md and the About panel: an entry created and
  deleted before any approver opens the page leaves no trace; a one-working-day gap still splits
  an approval run; Editors can technically write their own decisions (self-approval limits are UI).
- Readers skip `null` entries/decisions left by archiving.

## 6. Delivery steps
1. Plan review by independent agents → revise this plan.
2. Scaffold (Vite 8, React 19, TS 7, Vitest 5, Playwright 1.65, vite-plugin-singlefile).
3. Domain + unit tests → platform + fake → state → UI → e2e.
4. Code review by independent agents; fix until they give a green light.
5. `git init`, commit.
6. Publish to a **staging** artifact, seed it with a copy of the migrated live data, verify
   with `ArtifactData` reads at `as_level` view/interact (rules hold), and in the browser if
   available.
7. Migrate live: write ledger/decisions docs for the 2 live requests (v1 docs untouched),
   then publish to the live URL with the new capabilities. Rollback = republish v1 HTML with
   v1 capabilities; v1 data is untouched.
