# Negative balances and booking ahead — plan

Two features, asked 2026-11-23:

1. People may go **negative** on their vacation balance, down to a limit set in Settings
   (new setting, default **−10 days**). A booking that would go below the limit is **blocked**
   (for everyone, Editors booking for someone included).
2. People may book vacation **in a later year**. Those days come out of the **current year**
   (the year of "today" when booked): they use up what is left there and then push it
   negative, down to the limit. The later year's own allowance is not touched.

Today neither exists as a rule: the booking dialog only shows a red "That is X more than … has
left this year" line and still lets the booking through, and a booking in 2027 counts against
2027 (each day counts in the year it falls in). Feature 1 therefore **tightens** the current
behaviour (unlimited → −10).

Scope: vacation only (`DEDUCTING = {vacation}`). Time off in lieu, sick and remote are unchanged.

## 1. Data

### Settings
`config/settings.minBalance: number` — lowest allowed vacation balance, ≤ 0.
`DEFAULT_SETTINGS.minBalance = -10`. `parseSettings`: `finite(raw.minBalance, -10)`, clamped to
`≤ 0` (a positive value is treated as its negative; e.g. `10` → `-10`, so a mistyped sign never
blocks everyone). Missing on the live doc today → default −10, no migration needed.

### Entry: `chargeYear`
A vacation entry booked in year *Y* (viewer's `today`) that **ends after Y** gets
`chargeYear: Y`. Days of the booking that fall in years **after** `chargeYear` count against
`chargeYear`; days in `chargeYear` or earlier count in their own year. No `chargeYear` (all
existing bookings, and bookings within the current year) → each day counts in its own year, as now.

Why a stored field and not "the year of `createdAt`":
- Stable: on 1 January 2027 a Jan-2027 booking made in Nov 2026 must stay charged to 2026;
  deriving from `today` would move it.
- No retroactive change: existing 2027 bookings made in 2026 keep counting in 2027.
- It goes into the **fingerprint and snapshot**, so changing it after a decision flags the entry
  ("changed-after-decision") and the decided version keeps counting. `createdAt` is in neither.

Plumbing:
- `types.ts`: `LeaveEntry.chargeYear: number | null`; `DecisionSnapshot.chargeYear?: number | null`.
- `parse.ts`: `parseEntry` / `parseSnapshot` read it (integer 1900–9999, else `null`).
- `migrate.ts`: `entryBody` writes it **only when non-null** (old bodies byte-identical);
  `backportToV1` drops it (v1 counts the days in their own year; noted in rollback docs).
- `model.ts`: `fingerprint` appends `|cy=<n>` **only when non-null**, so every existing
  fingerprint — and therefore every existing decision — still matches. `snapshotOf`,
  `recordSnapshot`, `fromEntry`, `fromSnapshot`, `LeaveRecord` carry it.
- `actions.ts`: `archiveSerialize` writes it; `fromArchive` gets it via `parseLedger`.

### Which charge years are honoured (`effectiveChargeYear(r, archivedBefore)`)
Stored data is the person's own input (they can write raw to `ledger/{self}`), so the model
honours `chargeYear` only when:
- `type === "vacation"`,
- **`chargeYear === yearOf(end) - 1`** (one year back from where the booking ends, never more).
  Booking a Dec–Jan run in December gives `chargeYear = yearOf(start) = yearOf(end) - 1`;
  booking January in November gives `chargeYear = yearOf(start) - 1 = yearOf(end) - 1`,
- and `archivedBefore == null || chargeYear >= archivedBefore` (an archived year is closed).
Otherwise it is ignored (days count in their own year).

Consequence: the dialog only offers booking-ahead **into next year**. Vacation ending in
year ≥ Y+2 is refused ("You can book up to the end of {Y+1}"). This keeps the stored field to
one possible value per booking and keeps `recordsForYear(year)` (which already loads `year` and
`year + 1`) sufficient for archived-year balances.

Residual gap (documented): a person writing raw data in 2027 could set `chargeYear: 2026` on a
Jan-2027 booking to spend 2026's leftover days late. It is visible to approvers (the request shows
"Counts against 2026") and bounded to one year back and to unarchived years.

## 2. Balances (`model.ts`)

`balance(cal, model, member, year, extra)`: for vacation, each counted day goes to
`target = cy != null && yearOf(day) > cy ? cy : yearOf(day)` where `cy = effectiveChargeYear(r)`.
Sick / remote unchanged. `Balance` gains `ahead: number` — days in `taken + pending` that fall in
a later year than `year` (for display).

New pure helper:
```ts
chargeYearFor(today, draft) → number | null   // yearOf(today) if vacation && yearOf(end) > yearOf(today)
limitCheck(cal, model, member, draft, today) → { year, leftAfter, min, ok }[]
```
`limitCheck` builds the draft as a `LeaveRecord` (with its `chargeYear`), runs `balance` with it
as `extra` for every year it touches after charging, and reports `ok = leftAfter >= min` for each.
`leftAfter` includes pending (as `left` already does). Only years where the draft adds days are
checked, so someone already below the limit can still book sick days, remote days, or vacation
that only touches other years.

### Model-level guard (a raw write can't skip the limit)
In `buildModel`, after the threshold pass: for each member, take undecided vacation records that
derived as auto-approved, sorted by `start, id`; walk them with a running per-charge-year
balance seeded from everything else counted (decided-approved, pending, other undecided already
walked). A record that would take its charge year below `minBalance` becomes **`pending`**
(`auto = false`) — it goes to an approver instead of being silently accepted. Approved seals are
written only for auto-approved records, so honest bookings get sealed as before; changing the
limit later never reopens sealed bookings (same as the threshold).

`buildModel` needs `members` (has it) for entitlement/carryover — `entitlement()` /
`carryover()` already take `cal` + member.

## 3. UI

- **Settings → How this team works**: new field "Lowest vacation balance allowed" (number,
  `max=0`, `min=-60`, `step=0.5`, default −10) + one line of help: "People can go into minus down
  to this, e.g. to take leave before next year's days arrive. Bookings that would go lower are
  refused." `saveSettings` stores `-Math.abs(n)`.
- **Setup (first run)**: unchanged; new teams get the default.
- **Booking dialog**: replaces the single "left this year" line:
  - normal: "N vacation days would remain in 2026."
  - booking ahead: "Booked ahead: these days come out of your 2026 days. 2026 would be at −3
    (lowest allowed −10)." (and if the booking spans both years, the line covers both parts).
  - negative but allowed: amber (`warn`), not red.
  - over the limit: red, **Book disabled**: "That would take {name} to −12 in 2026; the lowest
    allowed is −10." If it's a booking ahead, add "From 1 January 2027 it comes out of the 2027
    days instead."
  - ending after next year: red, disabled: "Vacation can be booked up to the end of 2027."
- **`bookLeave`** (actions.ts) repeats both checks against the store at write time and throws
  `Refused` with the same messages; it sets `chargeYear` itself (from `store.today`), never from
  the dialog.
- **Balances**: "Left" cell is red only below the limit, amber when negative within it. A
  footnote when anyone has `ahead > 0`: "Includes vacation booked ahead in {y+1}, which counts
  against {y}." CSV: unchanged columns (Taken/Pending already include it).
- **Request detail**: row "Counts against: 2026 (booked ahead)" when `effectiveChargeYear` is set.
- **About panel / TESTING.md / README**: note the rule and the residual gap.

## 4. Tests

Unit (`test/unit/model.test.ts`, `platform.test.ts`):
- parseSettings: missing → −10; `5` → −5; `-3` → −3; junk → −10.
- parseEntry / snapshot round-trip with and without `chargeYear`; `entryBody` omits null.
- fingerprint unchanged for entries without `chargeYear` (fixed string from a pre-change entry).
- balance: Jan-2027 booking with `chargeYear 2026` counts in 2026, not 2027; Dec–Jan run all in
  2026; without `chargeYear` split by year (unchanged); forged `chargeYear` two years back ignored;
  `chargeYear` < `archivedBefore` ignored.
- limitCheck: ok at exactly −10, refused at −10.5; sick/remote never limited; already below the
  limit + booking only another year → ok.
- model guard: a raw over-limit auto-sized vacation entry derives as `pending`; a sealed one stays
  approved after the limit is raised; within-limit unaffected.
- changing `chargeYear` after a decision → `changed-after-decision`, decided snapshot counts.

E2E (today fixed to Mon 2 Mar 2026; add a spec `negative.spec.ts`):
- Book vacation down to −10 → allowed, amber; one more day → Book disabled with the message.
- Book in Jan 2027 → dialog says it comes out of 2026; Balances 2026 "Taken" includes it, 2027
  untouched; footnote shown.
- Book in 2028 → refused.
- Editor changes the limit to −2 in Settings → the dialog follows.
- Raw `window.claude` write of an over-limit booking → shows as pending for the approver.
- Parity oracle: unchanged data still renders identically (no `chargeYear` anywhere).

## 5. Delivery
1. Plan review by agents → revise. 2. Implement + tests. 3. `npm run check`. 4. Code review by
agents until green. 5. Commit on a branch. 6. Staging publish + browser check. 7. Live publish
only with the user's go-ahead.

---

## 6. Revision after plan review (2 reviewers: APPROVE WITH CHANGES) and the user's answers — supersedes §1–§5 where they differ

User answers (2026-11-23):
- Book ahead up to **31 December of next year** only (confirmed; today there is no limit).
- **Automatic carry-over, both signs**: in the new year a person gets their allowance
  (default 25, per-person overrides such as 30 already exist) **± whatever was left** at the end
  of the year before. The number an Editor types under Team → "Carried" becomes an
  **adjustment on top** of the automatic carry-over (a typed `0` = no adjustment), and the page
  must say so clearly.

### Carry-over
`carry(Y) = auto(Y) + adjustment[Y]`, where `adjustment = member.carryover[Y] ?? 0` (unchanged
storage) and `auto(Y) = left(Y−1)` when `Y−1 ≥ startYear(member)`, else 0.
`startYear = max(yearOf(settings.created), yearOf(member.addedAt))` (whichever exist; neither →
no automatic carry). Live/staging: created 2026-10-22, every member added 2026-10-22 → first
automatic carry is 2026 → 2027.
`left(Y−1)` for an archived year comes from the archive summary (`archive/{Y}.vacLeft[memberId]`,
written when the year is archived, from the full live model so booked-ahead records that end in
Y+1 are included); an archive without it → auto 0. `ModelInput.yearEnds` carries these into the
model so the result is the same on every machine (sealing waits for `loaded.archive`).

### Charge year (fixes reviewer issues)
- `LeaveRecord.chargeYear` = the honoured value, computed when the record is built:
  vacation and `chargeYear === yearOf(end) − 1`, else null. No `archivedBefore` condition
  (it would move days after archiving). Decided and archived records always keep theirs.
- `fromArchive` copies it explicitly; snapshot / decision / entry bodies include it **only when
  non-null**; `fingerprint` appends `|cy=` only when `!= null`; `parseSnapshot` validates it.
- Raw-write guard for late charges: an **undecided** record whose `chargeYear` year is over
  (today after 31 January of the following year — a grace month so an honest December booking
  not yet sealed isn't bounced) derives as **pending** with a flag. With automatic carry-over
  a late charge no longer gains days anyway (charging 2026 lowers 2027's carry by the same
  amount); it only changes which year's limit applies.

### Limit guard (order-independent)
After statuses are derived, per member and per year `Y ≥ archivedBefore` with `left(Y) < minBalance`:
every **undecided, auto-approved vacation record that adds days to Y** (after charging) becomes
`pending` with a new flag `over-limit`. Order-independent, so a forged earlier entry can't push an
honest later one into the queue while staying approved itself. Pending still counts in `left`, so
the result is a fixed point. Approvers may still approve it (documented).

### Booking check (`limitCheck`)
Checks the draft's charge year **and every later year** up to the last year with bookings
(carry-over passes a minus forward): refused if a year ends below the limit *and* the draft made
it lower. Someone already below the limit can still book sick/remote days.

### Writes
- `updateMember` with entitlement / carry-over changes runs the sealing pass first (as
  `saveSettings` does), so unsealed bookings can't flip to pending.
- `minBalance` parse: finite, positive → negative, clamped to [−366, 0], default −10.

### UI additions
- Team: field renamed **"Adjust"**, with "+N from 2026 automatically" shown next to it and in the
  tooltip; roster line "x taken, y left in 2027".
- Balances: "Carried over" = automatic + adjustment, tooltip with the split, footnote explaining it.
  "Left" amber when negative within the limit, red below it.
- Flags shown to approvers: "over the minus limit", "charged to a closed year".

### Rollout
- Editors reload open tabs after the publish (an old tab would seal bookings ahead without
  `cy` and drop `minBalance` on a settings save — falls back to −10). Documented in README.
- Before publishing live: read live data; anyone already below −10 with unsealed auto-approved
  bookings would see those go to pending.
- Rollback to v1 drops `chargeYear` (days count in their own year) and automatic carry-over.

### Later answers (same day) — supersede the carry-over start above
- Carry-over into **2027 is 0 for everyone**, even when 2026 ends in minus (that includes January
  2027 leave booked this year against 2026). Editors enter any 2027 carry-over by hand under
  Team → "Adjust ±"; the page says so in Team (2027 selected), in Balances and in Settings, and
  each Team row shows how 2026 ended. Automatic carry-over starts with 2027 → 2028.
- Implemented as `settings.carryFrom` (default 2027; new teams: the year they're created):
  `auto(Y) = left(Y−1)` when `Y−1 ≥ max(carryFrom, yearOf(member.addedAt))`.
