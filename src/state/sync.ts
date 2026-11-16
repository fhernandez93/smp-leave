/**
 * Boot and live subscriptions. Runs once, outside React (StrictMode-safe):
 * subscriptions are opened when the view starts and never from render.
 * At most 7 live subscriptions per view, whatever the team size.
 */
import { parseArchiveSummary, parseDecisions, parseJoiner, parseLedger, parseLink, parseMember, parseSettings } from "../platform/parse";
import { connect, errorCode, type DbError, type QuerySnap, type Unsubscribe } from "../platform/runtime";
import { todayISO } from "../domain/dates";
import type { Member } from "../domain/types";
import { store } from "./store";
import { toast } from "./actions";

const unsubs: Unsubscribe[] = [];

export function fail(msg: string): void {
  store.set({ fatal: msg });
}

export async function boot(): Promise<void> {
  const rt = await connect();
  if (!rt) return fail("This page needs to be opened from claude.ai so it can load the team’s data.");
  store.attach(rt);
  if (!rt.db) return fail("Shared data isn’t available in this view. Sign in to claude.ai and reopen the artifact.");
  if (rt.user) {
    const [uid, me, canWrite] = await Promise.all([rt.user.id(), rt.user.me(), rt.user.can("data.write")]);
    store.set({ uid, myName: me.name || "", isOwner: me.isOwner, isAdmin: me.canEdit || me.isOwner, canWrite });
  }
  subscribe();
  // keep "today" right for pages left open overnight
  setInterval(() => {
    const t = todayISO();
    if (t !== store.get().today) store.set({ today: t });
  }, 60_000);
}

function definitive(name: string, fromCache: boolean): Record<string, boolean> {
  const d = store.get().definitive;
  return d[name] === !fromCache ? d : { ...d, [name]: !fromCache };
}

function onErr(what: string) {
  return (e: DbError) => {
    const code = errorCode(e);
    if (code === "revoked" || code === "not_granted") store.set({ forcedReadOnly: true });
    else toast(`Lost the live connection to ${what}. Reload the page.`, true);
  };
}

function sizeOf(o: unknown): number {
  try {
    return JSON.stringify(o ?? {}).length;
  } catch {
    return 0;
  }
}

export function subscribe(): void {
  const { db, uid, isAdmin } = store.get();
  if (!db || unsubs.length) return;

  unsubs.push(db.doc("config/settings").onSnapshot((snap) => {
    const { settings, exists } = parseSettings(snap.data());
    store.set((s) => ({ settings, settingsExists: exists, loaded: { ...s.loaded, settings: true }, definitive: definitive("settings", snap.metadata.fromCache) }));
  }, onErr("settings")));

  unsubs.push(db.collection("members").limit(1000).onSnapshot((q: QuerySnap) => {
    const members = q.docs.map((d) => parseMember(d.id, d.data())).filter((m): m is Member => !!m);
    store.set((s) => ({ members, loaded: { ...s.loaded, members: true }, definitive: definitive("members", q.metadata.fromCache) }));
  }, onErr("the team roster")));

  unsubs.push(db.collection("links").limit(1000).onSnapshot((q) => {
    const links = q.docs.map((d) => parseLink(d.id, d.data())).filter((l) => !!l);
    store.set((s) => ({ links, loaded: { ...s.loaded, links: true }, definitive: definitive("links", q.metadata.fromCache) }));
  }, () => store.set((s) => ({ loaded: { ...s.loaded, links: true } }))));

  // one document per person; bounded by team size, not by history
  unsubs.push(db.collection("ledger").limit(1000).onSnapshot((q) => {
    const ledgers = new Map<string, ReturnType<typeof parseLedger>>();
    const ledgerBytes = new Map<string, number>();
    for (const d of q.docs) {
      const raw = d.data();
      ledgers.set(d.id, parseLedger(raw));
      ledgerBytes.set(d.id, sizeOf(raw));
    }
    store.set((s) => ({ ledgers, ledgerBytes, loaded: { ...s.loaded, ledgers: true }, definitive: definitive("ledger", q.metadata.fromCache) }));
  }, onErr("leave requests")));

  unsubs.push(db.collection("decisions").limit(1000).onSnapshot((q) => {
    const decisions = new Map<string, ReturnType<typeof parseDecisions>>();
    const decisionBytes = new Map<string, number>();
    for (const d of q.docs) {
      const raw = d.data();
      decisions.set(d.id, parseDecisions(raw));
      decisionBytes.set(d.id, sizeOf(raw));
    }
    store.set((s) => ({ decisions, decisionBytes, loaded: { ...s.loaded, decisions: true }, definitive: definitive("decisions", q.metadata.fromCache) }));
  }, onErr("decisions")));

  // one small summary document per archived year
  unsubs.push(db.collection("archive").limit(1000).onSnapshot((q) => {
    const archive = q.docs.map((d) => parseArchiveSummary(d.id, d.data())).filter((a) => !!a);
    store.set((s) => ({ archive, loaded: { ...s.loaded, archive: true } }));
  }, () => store.set((s) => ({ loaded: { ...s.loaded, archive: true } }))));

  if (isAdmin) {
    unsubs.push(db.collection("joiners").limit(200).onSnapshot((q) => {
      store.set({ joiners: q.docs.map((d) => parseJoiner(d.id, d.data())).filter((j) => !!j) });
    }, () => {}));
  } else if (uid) {
    unsubs.push(db.doc(`joiners/${uid}`).onSnapshot((snap) => {
      const j = snap.exists ? parseJoiner(snap.id, snap.data()) : null;
      store.set({ joiners: j ? [j] : [] });
    }, () => {}));
  }
}

/** Number of live subscriptions (tests assert the bound). */
export function subscriptionCount(): number {
  return unsubs.length;
}
