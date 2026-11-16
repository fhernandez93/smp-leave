import { useSyncExternalStore } from "react";
import { Calendar, DEFAULT_SETTINGS } from "../domain/calendar";
import { todayISO } from "../domain/dates";
import { buildModel, type LeaveOrOvertime, type Model } from "../domain/model";
import type { Decision, Entry, Joiner, Link, Member, Settings } from "../domain/types";
import type { ArchiveSummary } from "../platform/parse";
import type { Downloads, Profile, Runtime, User, DB } from "../platform/runtime";
import { pref } from "./prefs";

export type TlView = "year" | "month" | "week";
export const TL_VIEWS: TlView[] = ["year", "month", "week"];
export type Tab = "timeline" | "calendar" | "requests" | "balances" | "team" | "settings";
export const TABS: { id: Tab; label: string }[] = [
  { id: "timeline", label: "Timeline" },
  { id: "calendar", label: "Calendar" },
  { id: "requests", label: "Requests" },
  { id: "balances", label: "Balances" },
  { id: "team", label: "Team" },
  { id: "settings", label: "Settings" },
];

export type ReqFilter = "all" | "pending" | "mine" | "upcoming" | "vacation" | "overtime" | "comp" | "sick" | "remote" | "flagged";

export interface Toast { id: number; msg: string; bad: boolean }

export type ModalSpec =
  | { kind: "booking"; start?: string }
  | { kind: "overtime"; date?: string }
  | { kind: "request"; uid: string }
  | { kind: "addPeople"; tab?: "team" | "name"; seed?: string }
  | { kind: "import"; people: Profile[] }
  | { kind: "ask"; title: string; text?: string; label?: string; placeholder?: string; value?: string; ok?: string; danger?: boolean; required?: boolean; onOk: (v: string) => Promise<unknown> | unknown };

export interface State {
  // platform
  db: DB | null;
  user: User | null;
  downloads: Downloads | null;
  fatal: string | null;
  // viewer
  uid: string | null;
  myName: string;
  isOwner: boolean;
  isAdmin: boolean;
  /** can("data.write"): null = the platform said nothing */
  canWrite: boolean | null;
  /** set when a write to the viewer's own ledger was refused */
  forcedReadOnly: boolean;
  localMemberId: string | null;
  // shared data
  settings: Settings;
  settingsExists: boolean;
  members: Member[];
  links: Link[];
  ledgers: Map<string, Entry[]>;
  /** serialized size per ledger doc, for the capacity warning */
  ledgerBytes: Map<string, number>;
  decisions: Map<string, Map<string, Decision>>;
  decisionBytes: Map<string, number>;
  archive: ArchiveSummary[];
  joiners: Joiner[];
  /** archived years loaded on demand: year -> records ending that year */
  archived: Map<number, LeaveOrOvertime[]>;
  loaded: { settings: boolean; members: boolean; links: boolean; ledgers: boolean; decisions: boolean; archive: boolean };
  /** every subscription has delivered a server-definitive snapshot */
  definitive: Record<string, boolean>;
  profiles: Record<string, Profile>;
  today: string;
  // ui
  tab: Tab;
  year: number;
  calMonth: number;
  /** "Leaves at a glance" view */
  tlView: TlView;
  /** Monday of the week shown in the week view (kept in step with year/calMonth) */
  tlWeek: string | null;
  reqFilter: ReqFilter;
  toasts: Toast[];
  modal: ModalSpec | null;
  busy: boolean;
}

function initialTlView(): TlView {
  const v = pref("tlView");
  if (TL_VIEWS.some((x) => x === v)) return v as TlView;
  // a whole year is ~1100px wide; phones start on the month
  try {
    if (typeof matchMedia === "function" && matchMedia("(max-width: 640px)").matches) return "month";
  } catch {
    /* no media queries: fall through */
  }
  return "year";
}

function initialTab(): Tab {
  const t = pref("tab");
  return TABS.some((x) => x.id === t) ? (t as Tab) : "timeline";
}

export function initialState(now = new Date()): State {
  return {
    db: null, user: null, downloads: null, fatal: null,
    uid: null, myName: "", isOwner: false, isAdmin: false, canWrite: null, forcedReadOnly: false,
    localMemberId: pref("memberId"),
    settings: { ...DEFAULT_SETTINGS, holidays: [...DEFAULT_SETTINGS.holidays] }, settingsExists: false,
    members: [], links: [], ledgers: new Map(), ledgerBytes: new Map(), decisions: new Map(), decisionBytes: new Map(),
    archive: [], joiners: [], archived: new Map(),
    loaded: { settings: false, members: false, links: false, ledgers: false, decisions: false, archive: false },
    definitive: {},
    profiles: {},
    today: todayISO(now),
    tab: initialTab(),
    year: Number(pref("year")) || now.getFullYear(),
    calMonth: now.getMonth(),
    tlView: initialTlView(),
    tlWeek: null,
    reqFilter: "all",
    toasts: [],
    modal: null,
    busy: false,
  };
}

type Listener = () => void;

export class Store {
  private state: State;
  private listeners = new Set<Listener>();
  constructor(s: State = initialState()) {
    this.state = s;
  }
  get = (): State => this.state;
  set = (patch: Partial<State> | ((s: State) => Partial<State>)): void => {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of [...this.listeners]) l();
  };
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  attach(rt: Runtime): void {
    this.set({ db: rt.db, user: rt.user, downloads: rt.downloads });
  }
}

export const store = new Store();

/* ------------------------------------------------------------------ */
/* derived data, memoized on the identity of its inputs                 */
/* ------------------------------------------------------------------ */
export interface Derived {
  cal: Calendar;
  model: Model;
  /** roster entry that is the viewer, if known */
  memberId: string | null;
  me: Member | null;
  /** the viewer may open the booking dialog (enabled for every Contributor) */
  canBook: boolean;
  /** the viewer's roster entry isn't tied to their account yet (contested claim) */
  unbound: boolean;
  readOnly: boolean;
  isApprover: boolean;
  approverCount: number;
  activeMembers: Member[];
  ready: boolean;
}

let calMemo: { settings: Settings; cal: Calendar } | null = null;
let modelMemo: { key: unknown[]; model: Model } | null = null;
let derivedMemo: { state: State; d: Derived } | null = null;

export function displayName(s: Pick<State, "profiles">, m: Member | null | undefined, uidOf?: (id: string) => string | undefined): string {
  if (!m) return "Former member";
  if (m.name) return m.name;
  const u = m.uid || uidOf?.(m.id);
  const p = u ? s.profiles[u] : undefined;
  if (p?.name) return p.name;
  return m.nameHint || "Someone";
}

export function derive(s: State): Derived {
  if (derivedMemo && derivedMemo.state === s) return derivedMemo.d;
  if (!calMemo || calMemo.settings !== s.settings) calMemo = { settings: s.settings, cal: new Calendar(s.settings) };
  const cal = calMemo.cal;
  const key = [cal, s.members, s.links, s.ledgers, s.decisions, s.today];
  if (!modelMemo || modelMemo.key.some((k, i) => k !== key[i])) {
    modelMemo = { key, model: buildModel({ cal, members: s.members, links: s.links, ledgers: s.ledgers, decisions: s.decisions, today: s.today }) };
  }
  const model = modelMemo.model;
  const byId = new Map(s.members.map((m) => [m.id, m]));
  // Who am I? For a signed-in viewer only the shared data decides: the roster entry bound to
  // their account, or (while contested) the one their own claim points at. A remembered local
  // choice is used only when the platform gives no account id, so an Editor unlinking a wrong
  // claim really sends that person back to "Which one are you?".
  let memberId: string | null = null;
  if (s.uid) {
    if (model.bindings.memberOf.has(s.uid)) memberId = model.bindings.memberOf.get(s.uid)!;
    else {
      const claim = s.links.find((l) => l.uid === s.uid);
      if (claim && byId.has(claim.memberId) && !s.members.find((m) => m.id === claim.memberId)?.uid) memberId = claim.memberId;
      // a read-only viewer can't write a claim; let their remembered pick choose what to highlight
      else if (!claim && s.canWrite === false && s.localMemberId && byId.has(s.localMemberId) && !model.bindings.uidOf.has(s.localMemberId)) {
        memberId = s.localMemberId;
      }
    }
  } else if (s.localMemberId && byId.has(s.localMemberId) && !model.bindings.uidOf.has(s.localMemberId)) {
    memberId = s.localMemberId;
  }
  const me = memberId ? byId.get(memberId) ?? null : null;
  // Read-only ONLY when the platform says this viewer cannot write (can("data.write") === false,
  // or access revoked). A single refused write never disables booking — that was v1's
  // "Book leave greyed out for regular users" bug.
  const readOnly = s.canWrite === false || s.forcedReadOnly;
  const bound = !!memberId && !!s.uid && model.bindings.uidOf.get(memberId) === s.uid;
  // Anyone who can write and knows who they are can book. A booking made before an
  // Editor confirms a contested name is saved in the person's own ledger and counts
  // as soon as the name is confirmed (see `unbound`).
  const canBook = !readOnly && !!memberId && (!!s.uid || s.isAdmin);
  const unbound = !!memberId && !bound && !s.isAdmin;
  const activeMembers = s.members.filter((m) => !m.archived)
    .sort((a, b) => displayName(s, a, (id) => model.bindings.uidOf.get(id)).localeCompare(displayName(s, b, (id) => model.bindings.uidOf.get(id))));
  const ready = s.loaded.settings && s.loaded.members && s.loaded.ledgers && s.loaded.decisions && s.loaded.links;
  const d: Derived = {
    cal, model, memberId, me, canBook, readOnly, unbound,
    isApprover: s.isAdmin && !readOnly,
    approverCount: s.members.filter((m) => !m.archived && m.role === "manager").length,
    activeMembers, ready,
  };
  derivedMemo = { state: s, d };
  return d;
}

export function useApp(): [State, Derived] {
  const s = useSyncExternalStore(store.subscribe, store.get, store.get);
  return [s, derive(s)];
}

/** Name of a roster entry as this viewer sees it. */
export function nameOf(s: State, d: Derived, memberId: string | null | undefined): string {
  if (!memberId) return "Someone";
  const m = s.members.find((x) => x.id === memberId);
  return displayName(s, m, (id) => d.model.bindings.uidOf.get(id));
}
