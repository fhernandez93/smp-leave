/**
 * Every write the app makes. All go through `write()`, which maps platform
 * error codes to messages, and every entry/decision write is the complete
 * object with explicit nulls (update() merges nested objects field by field).
 */
import { DEFAULT_SETTINGS, HOLIDAY_VERSION } from "../domain/calendar";
import { countedDays, totalDays } from "../domain/counting";
import { yearOf } from "../domain/dates";
import { fingerprint, recordSnapshot, sealsNeeded, type LeaveOrOvertime, type LeaveRecord, type OvertimeRecord } from "../domain/model";
import type { Decision, DecisionStatus, Entry, LeaveType, Member, Settings } from "../domain/types";
import { decisionBody, entryBody } from "../platform/migrate";
import { errorCode, type DocRef } from "../platform/runtime";
import { parseLedger } from "../platform/parse";
import { setPref } from "./prefs";
import { derive, store, type ModalSpec, type ReqFilter, type Tab } from "./store";

export const NOTE_MAX = 500;
/** Refuse writes that would push a document near the platform's 256 KiB cap. */
export const DOC_HARD_LIMIT = 240 * 1024;
export const DOC_WARN = 150 * 1024;

let toastSeq = 0;
export function toast(msg: string, bad = false): void {
  const id = ++toastSeq;
  store.set((s) => ({ toasts: [...s.toasts, { id, msg, bad }] }));
  setTimeout(() => store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), bad ? 5200 : 3200);
}

export function newId(prefix: string): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const nowISO = () => new Date().toISOString();

class Refused extends Error {}

/**
 * Run a write; report the outcome. `ownLedger` marks writes whose refusal
 * means the viewer cannot write at all (they turn the page read-only); a
 * refused Editor-only write just says so.
 */
export async function write(fn: () => Promise<unknown>, okMsg?: string, opts: { ownLedger?: boolean } = {}): Promise<boolean> {
  try {
    try {
      await fn();
    } catch (e) {
      if (errorCode(e) !== "unavailable") throw e;
      // a transient platform condition: retry once after a short randomized delay
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
      await fn();
    }
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    if (e instanceof Refused) {
      toast(e.message, true);
      return false;
    }
    const code = errorCode(e);
    if (code === "invalid_argument" || code === "transform_error") {
      if (opts.ownLedger) {
        // Don't disable booking on one refusal (v1 did, which greyed the button out for
        // regular users after any failed write). Ask the platform what this viewer may do.
        const can = await store.get().user?.can("data.write").catch(() => null);
        if (can === false) {
          store.set({ canWrite: false });
          toast("You can view this tracker but not book. Ask its owner for Contributor access in the share menu.", true);
        } else {
          toast("That booking couldn’t be saved. Reload the page and try again.", true);
        }
      } else {
        toast("Only an Editor of this tracker can make that change.", true);
      }
    } else if (code === "quota_exceeded") {
      toast("The tracker’s storage is full. An Editor can archive old years in Settings.", true);
    } else if (code === "resource_exhausted") {
      toast("Too many changes at once. Wait a moment and try again.", true);
    } else if (code === "revoked" || code === "not_granted") {
      store.set({ forcedReadOnly: true });
      toast("Your access to this tracker changed. Reload the page.", true);
    } else {
      toast("That didn’t save. Check your connection and try again.", true);
    }
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* ui state                                                             */
/* ------------------------------------------------------------------ */
export function setTab(tab: Tab): void { store.set({ tab }); setPref("tab", tab); }
export function setYear(year: number): void { store.set({ year }); setPref("year", String(year)); void loadArchivedYear(year); }
export function setCalMonth(year: number, calMonth: number): void { store.set({ year, calMonth }); setPref("year", String(year)); void loadArchivedYear(year); }
export function setFilter(reqFilter: ReqFilter): void { store.set({ reqFilter }); }
export function openModal(modal: ModalSpec): void { store.set({ modal }); }
export function closeModal(): void { store.set({ modal: null }); }

/* ------------------------------------------------------------------ */
/* low-level document helpers                                           */
/* ------------------------------------------------------------------ */
function db() {
  const d = store.get().db;
  if (!d) throw new Refused("Shared data isn’t available in this view.");
  return d;
}

/** One lease holder per tab, so two tabs of the same person don't both "own" a lease. */
const TAB_ID = Math.random().toString(36).slice(2, 10);

/**
 * Create a container document once, without clobbering a concurrent creator
 * (another tab, or an Editor writing the same person's records): take a short
 * lease, re-read, and create only if it is still missing.
 */
async function ensureDoc(ref: DocRef, body: Record<string, unknown>): Promise<void> {
  const holder = `${store.get().uid || "anon"}:${TAB_ID}`;
  if (typeof ref.acquire === "function") {
    let acquired = false;
    for (let i = 0; i < 8 && !acquired; i++) {
      const lease = await ref.acquire({ holder, ttlMs: 4000 }).catch(() => ({ acquired: false }));
      acquired = lease.acquired;
      if (!acquired) await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
    }
    if (!acquired) {
      const again = await ref.get();
      if (again.exists) return;
      throw new Refused("Someone else is saving to the same record. Try again in a few seconds.");
    }
  }
  const snap = await ref.get();
  if (!snap.exists) await ref.set(body);
}

function checkSize(current: number, adding: unknown): void {
  const next = current + JSON.stringify(adding).length;
  if (next > DOC_HARD_LIMIT) throw new Refused("This person’s record is full. An Editor can archive old years in Settings to make room.");
}

/* ------------------------------------------------------------------ */
/* ledgers                                                              */
/* ------------------------------------------------------------------ */

/**
 * Where a new entry goes. A person writes their own ledger (keyed by their
 * Claude id); an Editor entering leave for someone else writes the
 * Editor-only ledger keyed by that person's roster id, which they cannot delete.
 */
export function ledgerKeyForWrite(memberId: string): string {
  const s = store.get();
  const d = derive(s);
  const bound = d.model.bindings.uidOf.get(memberId) === s.uid;
  // your own time goes to your own ledger (the rules let every Contributor write it);
  // an Editor whose name isn't linked yet records it in the Editor-only ledger instead
  if (s.uid && memberId === d.memberId && (bound || !s.isAdmin)) return s.uid;
  if (s.isAdmin) return memberId;
  throw new Refused("You can only book your own time.");
}

async function putEntry(key: string, e: Entry): Promise<void> {
  const s = store.get();
  const body = entryBody(e);
  checkSize(s.ledgerBytes.get(key) ?? 0, body);
  const ref = db().doc(`ledger/${key}`);
  if (!s.ledgers.has(key)) await ensureDoc(ref, { v: 2, entries: {} });
  await ref.update({ entries: { [e.id]: body } });
}

async function putDecision(key: string, d: Decision): Promise<void> {
  const s = store.get();
  const body = decisionBody(d);
  checkSize(s.decisionBytes.get(key) ?? 0, body);
  const ref = db().doc(`decisions/${key}`);
  if (!s.decisions.has(key)) await ensureDoc(ref, { v: 2, items: {} });
  await ref.update({ items: { [d.entryId]: body } });
}

export interface LeaveDraft {
  memberId: string;
  type: LeaveType;
  start: string;
  end: string;
  halfStart: boolean;
  halfEnd: boolean;
  halfPeriod: "am" | "pm" | null;
  note: string;
}

export function bookLeave(draft: LeaveDraft, pending: boolean): Promise<boolean> {
  const id = newId("r_");
  return write(async () => {
    const s = store.get();
    const d = derive(s);
    if (d.cal.settings.archivedBefore != null && yearOf(draft.end) < d.cal.settings.archivedBefore) {
      throw new Refused(`${yearOf(draft.end)} is archived. Bookings there can’t be added any more.`);
    }
    if (totalDays(d.cal, draft) <= 0) throw new Refused("That range has no working days in it.");
    const key = ledgerKeyForWrite(draft.memberId);
    const e: Entry = {
      id, kind: "leave", memberId: draft.memberId, type: draft.type,
      start: draft.start, end: draft.end, halfStart: draft.halfStart, halfEnd: draft.halfEnd && draft.start !== draft.end,
      halfPeriod: draft.halfStart && draft.start === draft.end ? draft.halfPeriod : null,
      note: draft.note.trim().slice(0, NOTE_MAX), createdBy: d.memberId, createdAt: nowISO(), withdrawnAt: null, withdrawnBy: null,
    };
    await putEntry(key, e);
  }, pending ? "Sent to an approver" : "Booked", { ownLedger: !store.get().isAdmin });
}

export function logOvertime(memberId: string, date: string, hours: number, note: string): Promise<boolean> {
  const id = newId("o_");
  return write(async () => {
    const s = store.get();
    const d = derive(s);
    if (!(hours > 0 && hours <= 24)) throw new Refused("Enter between 0.25 and 24 hours.");
    if (d.cal.settings.archivedBefore != null && yearOf(date) < d.cal.settings.archivedBefore) {
      throw new Refused(`${yearOf(date)} is archived. Overtime there can’t be added any more.`);
    }
    const key = ledgerKeyForWrite(memberId);
    const e: Entry = {
      id, kind: "overtime", memberId, date, hours, note: note.trim().slice(0, NOTE_MAX),
      createdBy: d.memberId, createdAt: nowISO(), withdrawnAt: null, withdrawnBy: null,
    };
    await putEntry(key, e);
  }, "Sent to an approver", { ownLedger: !store.get().isAdmin });
}

/** The person themself takes back an entry (pending at any time; approved only before it starts). */
export function withdraw(r: LeaveOrOvertime): Promise<boolean> {
  return write(async () => {
    const s = store.get();
    const d = derive(s);
    if (!r.entry) throw new Refused("This record is kept by the approvers. Ask one of them to cancel it.");
    const e = { ...r.entry, withdrawnAt: nowISO(), withdrawnBy: d.memberId };
    await db().doc(`ledger/${r.ledgerKey}`).update({ entries: { [e.id]: entryBody(e) } });
  }, r.kind === "overtime" ? "Removed" : "Cancelled", { ownLedger: true });
}

/** Can the viewer take this back themself? */
export function canWithdraw(r: LeaveOrOvertime): boolean {
  const s = store.get();
  const d = derive(s);
  if (d.readOnly || !r.entry || r.status === "cancelled" || r.status === "rejected") return false;
  if (r.memberId !== d.memberId) return false;
  if (!(s.uid && r.ledgerKey === s.uid) && !s.isAdmin) return false;
  if (r.status === "pending") return true;
  const start = r.kind === "leave" ? r.start : r.date;
  return s.today < start;
}

/* ------------------------------------------------------------------ */
/* decisions (Editors)                                                  */
/* ------------------------------------------------------------------ */
export function decide(r: LeaveOrOvertime, status: DecisionStatus, note = ""): Promise<boolean> {
  const msg = status === "approved" ? (r.kind === "overtime" ? "Approved — the hours are banked" : "Approved")
    : status === "rejected" ? "Declined" : r.kind === "overtime" ? "Removed" : "Cancelled";
  return write(async () => {
    const d = derive(store.get());
    // a record altered after an earlier decision is still judged as it was decided
    const keepOld = !r.entry || r.flags.includes("changed-after-decision");
    const fp = keepOld ? (r.decision?.fp ?? "") : fingerprint(r.ledgerKey, r.entry!);
    await putDecision(r.ledgerKey, {
      entryId: r.id, status, by: d.memberId, at: nowISO(), note: note.trim().slice(0, NOTE_MAX),
      fp, grandfathered: false, snapshot: recordSnapshot(r),
    });
  }, msg);
}

/** May the viewer approve or decline this pending record? (v1's self-approval rule kept.) */
export function canDecide(r: LeaveOrOvertime): boolean {
  const s = store.get();
  const d = derive(s);
  if (!d.isApprover || r.status !== "pending") return false;
  const mine = r.memberId === d.memberId;
  return !mine || d.approverCount <= 1 || s.isOwner;
}

/* ------------------------------------------------------------------ */
/* sealing pass + claim pinning (runs in an Editor's page)              */
/* ------------------------------------------------------------------ */
let sealing = false;
/** writes that failed this page load, with a count, so a broken one isn't retried forever */
const failures = new Map<string, number>();
const MAX_TRIES = 3;
const tooMany = (tag: string) => (failures.get(tag) ?? 0) >= MAX_TRIES;
const failed = (tag: string) => failures.set(tag, (failures.get(tag) ?? 0) + 1);

/** An uncontested claim is confirmed automatically only when the account's name matches the roster name. */
export function claimLooksRight(memberId: string, uid: string): boolean {
  const s = store.get();
  const m = s.members.find((x) => x.id === memberId);
  const account = (s.profiles[uid]?.name ?? "").trim().toLowerCase();
  if (!m || !account) return false;
  return [m.name, m.nameHint].some((n) => n && n.trim().toLowerCase() === account);
}

export async function sealPass(): Promise<number> {
  const s = store.get();
  const d = derive(s);
  if (sealing || !d.isApprover || !d.ready) return 0;
  if (!["settings", "members", "links", "ledger", "decisions"].every((k) => s.definitive[k])) return 0;
  sealing = true;
  let wrote = 0;
  try {
    // confirm uncontested claims whose account name matches the roster entry, so a later
    // contest cannot unbind the real person; anything else waits for an Editor in Team
    for (const memberId of d.model.bindings.unconfirmed) {
      const uid = d.model.bindings.uidOf.get(memberId);
      const tag = `pin:${memberId}:${uid}`;
      if (!uid || tooMany(tag) || !claimLooksRight(memberId, uid)) continue;
      try {
        await db().doc(`members/${memberId}`).update({ uid });
        wrote++;
      } catch {
        failed(tag);
      }
    }
    for (const x of sealsNeeded(d.model, nowISO(), s.today)) {
      const tag = `${x.ledgerKey}/${x.entryId}:${x.decision.fp}:${x.decision.status}`;
      if (tooMany(tag)) continue;
      try {
        await putDecision(x.ledgerKey, x.decision);
        wrote++;
      } catch {
        failed(tag); // retried by the next pass (at most MAX_TRIES per page load)
      }
    }
  } finally {
    sealing = false;
  }
  return wrote;
}

/* ------------------------------------------------------------------ */
/* identity                                                             */
/* ------------------------------------------------------------------ */
export async function claimMember(memberId: string): Promise<void> {
  const s = store.get();
  store.set({ localMemberId: memberId });
  setPref("memberId", memberId);
  if (!s.uid || !s.db) return;
  try { await s.db.doc(`data/users/${s.uid}/profile`).set({ memberId }); } catch { /* private subtree unavailable */ }
  try {
    await s.db.doc(`links/${s.uid}`).set({ memberId, at: nowISO() });
  } catch (e) {
    // The platform may not have said whether this viewer can write (can() → null, e.g. a
    // visitor from outside the organisation). A refused, well-formed write settles it: show
    // the tracker read-only with their pick highlighted, rather than keeping them out (v1 let them in).
    // Only when the platform hadn't said: never take booking away from someone it said can write.
    if ((errorCode(e) === "invalid_argument" || errorCode(e) === "transform_error") && store.get().canWrite === null) store.set({ canWrite: false });
    else toast("That didn’t save. Check your connection and try again.", true);
  }
}

/** Restore "which roster entry am I" from the private per-viewer profile. */
export async function restoreProfile(): Promise<void> {
  const s = store.get();
  if (!s.db || !s.uid || s.localMemberId) return;
  try {
    const snap = await s.db.doc(`data/users/${s.uid}/profile`).get();
    const mid = snap.exists ? snap.data()?.memberId : null;
    if (typeof mid === "string") store.set({ localMemberId: mid });
  } catch { /* fine */ }
}

export async function askToJoin(): Promise<boolean> {
  const s = store.get();
  try {
    await db().doc(`joiners/${s.uid}`).set({ nameHint: s.myName || "", requestedAt: nowISO() });
    toast("Sent to the Editors");
    return true;
  } catch (e) {
    if (errorCode(e) === "invalid_argument" && store.get().canWrite === null) {
      store.set({ canWrite: false });
      toast("You can view this tracker but not join it. Ask its owner for Contributor access.", true);
    } else toast("That didn’t save. Check your connection and try again.", true);
    return false;
  }
}
export function withdrawJoin(): Promise<boolean> {
  const s = store.get();
  return write(() => db().doc(`joiners/${s.uid}`).delete(), "Withdrawn");
}

/* ------------------------------------------------------------------ */
/* roster (Editors)                                                     */
/* ------------------------------------------------------------------ */
export function blankMember(over: Partial<Member> & Record<string, unknown>): Record<string, unknown> {
  return {
    name: "", nameHint: "", uid: null, role: "member", entitlements: {}, carryover: {}, archived: false,
    keepUnresolved: false, source: "manual", addedAt: nowISO(), leftAt: null, ...over,
  };
}

export async function addMember(body: Record<string, unknown>, okMsg?: string): Promise<string | null> {
  const id = newId("m_");
  return (await write(() => db().doc(`members/${id}`).set(body), okMsg)) ? id : null;
}
export function updateMember(id: string, patch: Record<string, unknown>, okMsg?: string): Promise<boolean> {
  return write(() => db().doc(`members/${id}`).update(patch), okMsg);
}
export function acceptJoiner(uid: string, nameHint: string): Promise<boolean> {
  return write(async () => {
    await db().doc(`members/${newId("m_")}`).set(blankMember({ uid, nameHint, source: "request" }));
    await db().doc(`joiners/${uid}`).delete();
  }, `Added ${nameHint || "them"}`);
}
export function dismissJoiner(uid: string): Promise<boolean> {
  return write(() => db().doc(`joiners/${uid}`).delete(), "Dismissed");
}
/** Remove a claim: the account is no longer this roster entry. */
export function unlink(memberId: string): Promise<boolean> {
  return write(async () => {
    const s = store.get();
    const d = derive(s);
    const uid = d.model.bindings.uidOf.get(memberId);
    // what that account booked under this name was sealed or decided while it was linked;
    // once unlinked those records would still count for the real person, so cancel them
    if (uid) {
      for (const r of d.model.records) {
        if (r.ledgerKey !== uid || r.memberId !== memberId || !r.decision || r.decision.status !== "approved") continue;
        await putDecision(r.ledgerKey, {
          entryId: r.id, status: "cancelled", by: d.memberId, at: nowISO(), note: "Booked by an account that was unlinked from this name",
          fp: r.decision.fp, grandfathered: false, snapshot: recordSnapshot(r),
        });
      }
    }
    await db().doc(`members/${memberId}`).update({ uid: null });
    // remove every claim on this roster entry, or the next pass would bind it again
    for (const l of s.links.filter((x) => x.memberId === memberId)) await db().doc(`links/${l.uid}`).delete();
  }, "Unlinked");
}
export function pin(memberId: string, uid: string): Promise<boolean> {
  return write(() => db().doc(`members/${memberId}`).update({ uid }), "Confirmed");
}

export async function createTeam(teamName: string, defaultDays: number, approvalThreshold: number, people: { name: string; role: "member" | "manager" }[]): Promise<boolean> {
  const s = store.get();
  return write(async () => {
    // never overwrite an existing team's settings (a cached, partial first snapshot can look empty)
    const existing = await db().doc("config/settings").get();
    if (!existing.exists) {
      await db().doc("config/settings").set({ ...DEFAULT_SETTINGS, holidayVersion: HOLIDAY_VERSION, teamName: teamName || DEFAULT_SETTINGS.teamName, defaultDays, approvalThreshold, created: nowISO() } as unknown as Record<string, unknown>);
    }
    const again = await db().collection("members").limit(1).get();
    if (!again.empty) throw new Refused("This tracker already has a roster. Reload the page.");
    for (const p of people) {
      const isMe = !!s.myName && p.name === s.myName;
      await db().doc(`members/${newId("m_")}`).set(blankMember({ name: isMe ? "" : p.name, nameHint: p.name, role: p.role, uid: isMe ? s.uid : null, source: isMe ? "self" : "manual" }));
    }
  }, "Team created");
}

/* ------------------------------------------------------------------ */
/* settings (Editors)                                                   */
/* ------------------------------------------------------------------ */
/**
 * Seal every self-booked status first, so changing the threshold, working
 * days or holidays never turns past bookings back into pending ones.
 */
export function saveSettings(patch: Partial<Settings>): Promise<boolean> {
  return write(async () => {
    await sealPass();
    await new Promise((r) => setTimeout(r, 0));
    const pre = store.get();
    if (sealsNeeded(derive(pre).model, nowISO(), pre.today).length) {
      throw new Refused("Some current bookings couldn’t be recorded first, so the settings weren’t changed. Try again in a moment.");
    }
    const s = store.get();
    const next = { ...s.settings, ...patch, holidayVersion: HOLIDAY_VERSION };
    if (!next.created) next.created = nowISO();
    await db().doc("config/settings").set(next as unknown as Record<string, unknown>);
  }, "Settings saved");
}

/* ------------------------------------------------------------------ */
/* archive (Editors)                                                    */
/* ------------------------------------------------------------------ */
function endOf(r: LeaveOrOvertime) { return r.kind === "leave" ? r.end : r.date; }

export function archiveSerialize(r: LeaveOrOvertime): Record<string, unknown> {
  const base = { id: r.id, ledgerKey: r.ledgerKey, memberId: r.memberId, status: r.status, auto: r.auto, note: r.note, createdBy: r.createdBy, createdAt: r.createdAt,
    decision: r.decision ? decisionBody(r.decision) : null };
  return r.kind === "leave"
    ? { ...base, kind: "leave", type: r.type, start: r.start, end: r.end, halfStart: r.halfStart, halfEnd: r.halfEnd, halfPeriod: r.halfPeriod }
    : { ...base, kind: "overtime", date: r.date, hours: r.hours };
}

/** Which year the next archive run would cover, and why it may not be possible yet. */
export function archiveCandidate(): { year: number | null; blockers: string[] } {
  const s = store.get();
  const d = derive(s);
  const thisYear = yearOf(s.today);
  const years = d.model.records.map((r) => yearOf(endOf(r)));
  const first = s.settings.archivedBefore ?? (years.length ? Math.min(...years) : thisYear);
  if (first >= thisYear - 1) return { year: null, blockers: ["Only years before last year can be archived."] };
  const pending = d.model.records.filter((r) => yearOf(endOf(r)) === first && r.status === "pending").length;
  return { year: first, blockers: pending ? [`Decide the ${pending} pending request${pending === 1 ? "" : "s"} from ${first} first.`] : [] };
}

/**
 * Archive one year: write the archive documents (absolute, idempotent),
 * read them back, advance `archivedBefore`, then clear the live copies.
 * Totals ignore live records before `archivedBefore`, so an interrupted run
 * never counts anything twice; running it again finishes the job.
 */
export function archiveYear(year: number): Promise<boolean> {
  return write(async () => {
    const s = store.get();
    const d = derive(s);
    const lock = db().doc("config/archive");
    if (typeof lock.acquire === "function") {
      const lease = await lock.acquire({ holder: `${s.uid || "admin"}:${TAB_ID}`, ttlMs: 120_000 }).catch(() => ({ acquired: false }));
      if (!lease.acquired) throw new Refused("Another Editor is archiving right now. Try again in a couple of minutes.");
    }
    await finishInterruptedArchive();
    if (s.settings.archivedBefore != null && year !== s.settings.archivedBefore) throw new Refused("Archive the oldest live year first.");
    // only records that END in this year; anything older is already archived (or was booked late and is ignored)
    const recs = d.model.records.filter((r) => yearOf(endOf(r)) === year);
    if (recs.some((r) => r.status === "pending")) throw new Refused(`Decide the pending requests from ${year} first.`);
    const hpd = d.cal.hoursPerDay();
    const carry: Record<string, { earnedH: number; spentH: number }> = {};
    const byKey = new Map<string, LeaveOrOvertime[]>();
    for (const r of recs) {
      byKey.set(r.ledgerKey, [...(byKey.get(r.ledgerKey) ?? []), r]);
      const c = (carry[r.memberId] ??= { earnedH: 0, spentH: 0 });
      if (r.kind === "overtime" && r.status === "approved") c.earnedH += r.hours;
      if (r.kind === "leave" && r.type === "comp" && r.status !== "rejected" && r.status !== "cancelled") c.spentH += totalDays(d.cal, r) * hpd;
    }
    await db().doc(`archive/${year}`).set({ year, hoursPerDay: hpd, carry, complete: false, at: nowISO() });
    for (const [key, list] of byKey) {
      await db().doc(`archive/${year}/ledgers/${key}`).set({ year, records: list.map(archiveSerialize) });
    }
    // verify before touching anything live
    for (const [key, list] of byKey) {
      const snap = await db().doc(`archive/${year}/ledgers/${key}`).get();
      const n = Array.isArray(snap.data()?.records) ? (snap.data()!.records as unknown[]).length : -1;
      if (n !== list.length) throw new Refused("The archive didn’t read back correctly. Nothing live was changed; try again.");
    }
    await db().doc(`archive/${year}`).update({ complete: true });
    await db().doc("config/settings").update({ archivedBefore: year + 1 });
    for (const [key, list] of byKey) {
      const entries: Record<string, null> = {};
      const items: Record<string, null> = {};
      for (const r of list) {
        if (r.entry) entries[r.id] = null;
        if (r.decision) items[r.id] = null;
      }
      if (Object.keys(entries).length && s.ledgers.has(key)) await db().doc(`ledger/${key}`).update({ entries });
      if (Object.keys(items).length && s.decisions.has(key)) await db().doc(`decisions/${key}`).update({ items });
    }
    store.set({ archived: new Map() });
    void loadArchivedYear(store.get().year);
  }, `Archived ${year}`);
}

/**
 * If an earlier run stopped after advancing `archivedBefore` but before clearing
 * the live copies, clear the ones the archive already holds. Records in an
 * archived year that the archive does NOT hold were booked late; they stay
 * ignored (and are listed in Settings).
 */
async function finishInterruptedArchive(): Promise<void> {
  const s = store.get();
  const d = derive(s);
  const byDoc = new Map<string, LeaveOrOvertime[]>();
  for (const r of d.model.late) {
    if (!r.entry && !r.decision) continue;
    const k = `${yearOf(endOf(r))}|${r.ledgerKey}`;
    byDoc.set(k, [...(byDoc.get(k) ?? []), r]);
  }
  for (const [k, list] of byDoc) {
    const [y, key] = k.split("|") as [string, string];
    const snap = await db().doc(`archive/${y}/ledgers/${key}`).get();
    const held = new Set(((snap.data()?.records as { id?: string }[] | undefined) ?? []).map((x) => x.id));
    const entries: Record<string, null> = {};
    const items: Record<string, null> = {};
    for (const r of list) {
      if (!held.has(r.id)) continue;
      if (r.entry) entries[r.id] = null;
      if (r.decision) items[r.id] = null;
    }
    if (Object.keys(entries).length) await db().doc(`ledger/${key}`).update({ entries });
    if (Object.keys(items).length) await db().doc(`decisions/${key}`).update({ items });
  }
}

/** Load the archived records a past year's views need (that year and the next, for leave crossing New Year). */
export async function loadArchivedYear(year: number): Promise<void> {
  const s = store.get();
  const before = s.settings.archivedBefore;
  if (!s.db || before == null || year >= before) return;
  const want = [year, year + 1].filter((y) => y < before && !store.get().archived.has(y));
  for (const y of want) {
    try {
      const q = await s.db.collection(`archive/${y}/ledgers`).limit(1000).get();
      const recs: LeaveOrOvertime[] = [];
      for (const doc of q.docs) {
        const raw = doc.data();
        if (!raw || !Array.isArray(raw.records)) continue;
        for (const x of raw.records as Record<string, unknown>[]) {
          const r = fromArchive(doc.id, x);
          if (r) recs.push(r);
        }
      }
      store.set((st) => ({ archived: new Map(st.archived).set(y, recs) }));
    } catch {
      toast(`Couldn’t load the archived records for ${y}.`, true);
    }
  }
}

function fromArchive(key: string, x: Record<string, unknown>): LeaveOrOvertime | null {
  const entries = parseLedger({ entries: { [String(x.id)]: x } });
  const e = entries[0];
  if (!e) return null;
  const status = (["approved", "rejected", "cancelled", "pending"] as const).find((v) => v === x.status) ?? "approved";
  const base = { uid: `${key}/${e.id}`, id: e.id, ledgerKey: key, memberId: e.memberId, status, auto: x.auto === true, decision: null,
    note: e.note, createdBy: e.createdBy, createdAt: e.createdAt, withdrawnAt: null, flags: [], entry: null };
  if (e.kind === "leave") return { ...base, kind: "leave", type: e.type, start: e.start, end: e.end, halfStart: e.halfStart, halfEnd: e.halfEnd, halfPeriod: e.halfPeriod } as LeaveRecord;
  return { ...base, kind: "overtime", date: e.date, hours: e.hours } as OvertimeRecord;
}

/** Overtime carried forward from archived years. */
export function archiveCarries() {
  const s = store.get();
  const before = s.settings.archivedBefore;
  return s.archive.filter((a) => a.complete && before != null && a.year < before).map((a) => a.carry);
}

/** All records shown for a year: live ones plus, for archived years, the archive. */
export function recordsForYear(year: number): LeaveOrOvertime[] {
  const s = store.get();
  const d = derive(s);
  const before = s.settings.archivedBefore;
  if (before == null || year >= before) return d.model.records;
  return [...(s.archived.get(year) ?? []), ...(s.archived.get(year + 1) ?? []), ...(year + 1 >= before ? d.model.records : [])];
}

/** Days a record keeps someone away in a given year. */
export function leaveDaysInYear(r: LeaveRecord, year: number): number {
  const d = derive(store.get());
  return countedDays(d.cal, r).reduce((a, x) => a + (yearOf(x.date) === year ? x.w : 0), 0);
}
