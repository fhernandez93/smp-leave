/**
 * An in-memory stand-in for the claude.ai artifact runtime (`window.claude`),
 * used by the e2e tests and by unit tests of the rules engine.
 *
 * It implements the subset of the 0.2.89 contract the app uses — db (doc,
 * collection, get/set/update/delete/onSnapshot, where/orderBy/limit), user
 * (id, me, can, canEdit, isOwner, profiles, search) and downloads (save) —
 * and it ENFORCES an access-rules declaration with the documented
 * semantics (levels, inheritance, `{self}` subtrees, prefix rules,
 * data/users privacy). The store lives in localStorage so several pages of
 * one browser context share it and see each other's writes live (via the
 * `storage` event), like several viewers of one artifact.
 *
 * IMPORTANT: this function is serialised with Function.prototype.toString
 * by Playwright's addInitScript, so it must not reference anything outside
 * its own body.
 *
 * Blind spots versus the real platform (documented in README): no network
 * latency or `fromCache` snapshots, no quotas/size caps beyond a simple
 * 256 KiB doc check, no rate limits, no `revoked`, profiles/search are a
 * fixed directory, and rule semantics are our reading of db.d.ts.
 */

export type Level = "view" | "interact" | "admin" | "owner";

export interface FakeRule {
  path: string;
  read?: Level;
  write?: Level;
}

export interface FakeViewer {
  uid: string | null;
  name: string;
  level: Level;
  email?: string | null;
}

export interface FakeArg {
  viewer: FakeViewer | null;
  rules: FakeRule[];
  directory: { id: string; name: string; email?: string | null }[];
  storageKey?: string;
  /** Seed the store if it is empty: { "path/of/doc": {...} } */
  seed?: Record<string, Record<string, unknown>> | null;
  /** Make capabilities unavailable, to test degraded views. */
  disable?: ("db" | "user" | "downloads")[];
  /** can("data.write") answer override (null = platform said nothing). */
  canWrite?: boolean | null;
  /** base delivery latency in ms (default 15) */
  latencyMs?: number;
  /** what the cache-marked first delivery holds: the current data (default) or nothing */
  cacheFirst?: "same" | "empty";
}

export function installFakeClaude(arg: FakeArg): void {
  const g = globalThis as unknown as Record<string, unknown> & { localStorage: Storage; addEventListener?: (t: string, f: (e: { key: string | null }) => void) => void };
  const KEY = arg.storageKey || "fake-claude-db";
  const ORDER: Record<string, number> = { view: 0, interact: 1, admin: 2, owner: 3 };
  const viewer = arg.viewer;
  const myLevel: number = viewer ? ORDER[viewer.level]! : -1;
  const disabled = new Set(arg.disable || []);

  type Doc = { data: Record<string, unknown>; version: number };
  type Store = Record<string, Doc>;

  function load(): Store {
    try {
      const raw = g.localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as Store) : {};
    } catch {
      return {};
    }
  }
  function save(s: Store): void {
    g.localStorage.setItem(KEY, JSON.stringify(s));
  }
  if (arg.seed && Object.keys(load()).length === 0) {
    const s: Store = {};
    for (const [p, d] of Object.entries(arg.seed)) s[p] = { data: d, version: 1 };
    save(s);
  }

  function err(code: string, message: string) {
    return { code, message };
  }

  /* ------------------------------------------------------------------ */
  /* rules engine                                                        */
  /* ------------------------------------------------------------------ */
  const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  function segs(path: string): string[] {
    if (path === "") return [];
    const parts = path.split("/");
    for (const p of parts) {
      if (!SEG.test(p) || p === "." || p === "..") throw new TypeError("bad path segment: " + path);
    }
    return parts;
  }
  const rules: FakeRule[] = arg.rules.slice();
  if (!rules.some((r) => r.path === "data/users/{self}")) rules.push({ path: "data/users/{self}" });
  const parsedRules = rules.map((r) => ({ ...r, parts: r.path === "" ? [] : r.path.split("/") }));

  /** Effective {read, write} minimum levels for a document path; null = invisible (sibling {self} subtree). */
  function levelsFor(docPath: string): { read: number; write: number } | null {
    const parts = segs(docPath);
    let read = ORDER.view!;
    let write = ORDER.interact!;
    const root = parsedRules.find((r) => r.parts.length === 0);
    if (root) {
      if (root.read) read = ORDER[root.read]!;
      if (root.write) write = ORDER[root.write]!;
    }
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth);
      // a {self} rule at this depth?
      const selfRule = parsedRules.find(
        (r) => r.parts.length === depth && r.parts[depth - 1] === "{self}" && r.parts.slice(0, depth - 1).join("/") === prefix.slice(0, depth - 1).join("/"),
      );
      if (selfRule) {
        const isMine = viewer?.uid != null && prefix[depth - 1] === viewer.uid;
        if (isMine) {
          if (selfRule.read) read = ORDER[selfRule.read]!;
          if (selfRule.write) write = ORDER[selfRule.write]!;
        } else {
          const prefixRule = parsedRules.find((r) => r.parts.join("/") === prefix.slice(0, depth - 1).join("/") && r.parts.length === depth - 1);
          if (!prefixRule || depth - 1 === 0) return null; // siblings stay private
        }
        continue;
      }
      const exact = parsedRules.find((r) => r.parts.length === depth && r.parts.join("/") === prefix.join("/"));
      if (exact) {
        if (exact.read) read = ORDER[exact.read]!;
        if (exact.write) write = ORDER[exact.write]!;
      }
    }
    if (write < read) write = read;
    if (write < ORDER.interact!) write = ORDER.interact!; // `view` only ever widens reads
    return { read, write };
  }
  function meets(min: number): boolean {
    if (!viewer) return false;
    if (viewer.level === "owner") return true;
    return myLevel >= min;
  }
  function canRead(docPath: string): boolean {
    const l = levelsFor(docPath);
    return !!l && meets(l.read);
  }
  function canWriteDoc(docPath: string): boolean {
    const l = levelsFor(docPath);
    return !!l && meets(l.write);
  }

  /* ------------------------------------------------------------------ */
  /* snapshots                                                           */
  /* ------------------------------------------------------------------ */
  function deepFreeze<T>(o: T): T {
    if (o && typeof o === "object") {
      Object.freeze(o);
      for (const v of Object.values(o as object)) deepFreeze(v);
    }
    return o;
  }
  function clone<T>(o: T): T {
    return JSON.parse(JSON.stringify(o)) as T;
  }
  type Meta = { fromCache: boolean; hasPendingWrites: boolean };
  const LIVE: Meta = Object.freeze({ fromCache: false, hasPendingWrites: false });
  const CACHED: Meta = Object.freeze({ fromCache: true, hasPendingWrites: false });
  function docSnap(path: string, store: Store, meta: Meta = LIVE) {
    const p = segs(path);
    const visible = canRead(path) && !!store[path];
    const body = visible ? deepFreeze(clone(store[path]!.data)) : undefined;
    return { id: p[p.length - 1]!, exists: visible, data: () => body, metadata: meta };
  }

  type Filter = [string, string, unknown];
  interface QSpec {
    coll: string;
    filters: Filter[];
    order: [string, "asc" | "desc"] | null;
    lim: number | null;
  }
  function cmp(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    return (a as number) < (b as number) ? -1 : 1;
  }
  function test(v: unknown, op: string, x: unknown): boolean {
    switch (op) {
      case "==": return v === x;
      case "!=": return v !== x;
      case "<": return (v as number) < (x as number);
      case "<=": return (v as number) <= (x as number);
      case ">": return (v as number) > (x as number);
      case ">=": return (v as number) >= (x as number);
      case "in": return Array.isArray(x) && x.includes(v);
      case "not-in": return Array.isArray(x) && !x.includes(v);
      case "array-contains": return Array.isArray(v) && v.includes(x);
      default: throw err("invalid_argument", "bad operator " + op);
    }
  }
  function runQuery(q: QSpec, store: Store, meta: Meta = LIVE) {
    const depth = segs(q.coll).length + 1;
    let docs = Object.keys(store)
      .filter((p) => p.startsWith(q.coll + "/") && p.split("/").length === depth)
      .filter((p) => canRead(p))
      .map((p) => ({ path: p, data: store[p]!.data }));
    for (const [f, op, x] of q.filters) docs = docs.filter((d) => test(d.data[f], op, x));
    if (q.order) {
      const [f, dir] = q.order;
      docs.sort((a, b) => {
        const av = a.data[f], bv = b.data[f];
        if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? 1 : -1; // missing sorts last
        return (dir === "desc" ? -1 : 1) * cmp(av, bv);
      });
    } else docs.sort((a, b) => (a.path < b.path ? -1 : 1));
    if (q.lim != null) docs = docs.slice(0, q.lim);
    const out = docs.map((d) => docSnap(d.path, store, meta));
    return { docs: out, size: out.length, empty: out.length === 0, docChanges: () => [], metadata: meta };
  }

  /* ------------------------------------------------------------------ */
  /* subscriptions                                                       */
  /* ------------------------------------------------------------------ */
  const listeners = new Set<() => void>();
  let pending = false;
  function notify(): void {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      for (const l of [...listeners]) l();
    }, 0);
  }
  if (typeof g.addEventListener === "function") {
    g.addEventListener("storage", (e) => {
      if (e.key === KEY) notify();
    });
  }
  const LATENCY = arg.latencyMs ?? 15;
  const errorSinks = new Set<(e: unknown) => void>();
  let revoked = false;
  function subscribe(compute: (s: Store, m: Meta) => unknown, next: (v: never) => void, error?: (e: unknown) => void): () => void {
    let last = "";
    let live = true;
    if (error) {
      const sink = (e: unknown) => { if (live) { live = false; listeners.delete(run); error(e); } };
      errorSinks.add(sink);
    }
    const run = () => {
      if (!live) return;
      const v = compute(load(), LIVE);
      // include document bodies, so content-only changes are delivered too
      const sig = JSON.stringify(v, function (this: unknown, k, val) {
        if (k === "data" && typeof val === "function") return (val as () => unknown).call(this);
        return typeof val === "function" ? undefined : val;
      });
      if (sig === last) return;
      last = sig;
      next(v as never);
    };
    listeners.add(run);
    if (listeners.size > 64) {
      listeners.delete(run);
      throw err("resource_exhausted", "subscription cap");
    }
    // like the platform: a cache-marked first delivery, then the server-definitive one
    setTimeout(() => { if (live) next(compute(arg.cacheFirst === "empty" ? {} : load(), CACHED) as never); }, 0);
    setTimeout(run, LATENCY + Math.random() * LATENCY);
    return () => {
      live = false;
      listeners.delete(run);
    };
  }

  /* ------------------------------------------------------------------ */
  /* writes                                                              */
  /* ------------------------------------------------------------------ */
  function isPlain(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }
  function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k] as Record<string, unknown>, v) : v;
    return out;
  }
  function checkBody(data: unknown): Record<string, unknown> {
    if (!isPlain(data)) throw err("invalid_argument", "body must be an object");
    const s = JSON.stringify(data);
    if (s.length > 256 * 1024) throw err("invalid_argument", "document over 256 KiB");
    return JSON.parse(s) as Record<string, unknown>;
  }
  function guardWrite(path: string): void {
    if (revoked) throw err("revoked", "access withdrawn");
    if (!viewer) throw err("invalid_argument", "signed out");
    if (!canWriteDoc(path)) throw err("invalid_argument", "write refused by access rules at " + path);
  }

  const writeLog: { op: string; path: string; ok: boolean }[] = [];
  const leases = new Map<string, { holder: string; expires: number }>();
  const faults: { code: string; pathPrefix: string }[] = [];
  function logged<T>(op: string, path: string, fn: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const fi = faults.findIndex((f) => path.startsWith(f.pathPrefix));
        if (fi >= 0) {
          const f = faults.splice(fi, 1)[0]!;
          writeLog.push({ op, path, ok: false });
          reject(err(f.code, "injected fault"));
          return;
        }
        try {
          const v = fn();
          writeLog.push({ op, path, ok: true });
          notify();
          resolve(v);
        } catch (e) {
          writeLog.push({ op, path, ok: false });
          reject(e);
        }
      }, LATENCY / 3);
    });
  }

  function docRef(path: string): unknown {
    const p = segs(path);
    if (p.length % 2 !== 0 || p.length === 0) throw new TypeError("document paths need an even number of segments: " + path);
    return {
      id: p[p.length - 1],
      path,
      get: () => Promise.resolve(docSnap(path, load())),
      set: (data: unknown) =>
        logged("set", path, () => {
          guardWrite(path);
          const body = checkBody(data);
          const s = load();
          s[path] = { data: body, version: (s[path]?.version || 0) + 1 };
          save(s);
        }),
      update: (data: unknown) =>
        logged("update", path, () => {
          guardWrite(path);
          const body = checkBody(data);
          const s = load();
          if (!s[path] || !canRead(path)) throw err("invalid_argument", "update of a missing document");
          s[path] = { data: checkBody(merge(s[path]!.data, body)), version: s[path]!.version + 1 };
          save(s);
        }),
      delete: () =>
        logged("delete", path, () => {
          guardWrite(path);
          const s = load();
          delete s[path];
          save(s);
        }),
      acquire: async (o: { holder: string; ttlMs?: number }) => {
        const now = Date.now();
        const held = leases.get(path);
        if (held && held.expires > now && held.holder !== o.holder) return { acquired: false, expiresAt: new Date(held.expires).toISOString() };
        const expires = now + Math.min(Math.max(o.ttlMs || 30000, 1000), 600000);
        leases.set(path, { holder: o.holder, expires });
        return { acquired: true, holder: o.holder, expiresAt: new Date(expires).toISOString(), version: 1 };
      },
      onSnapshot: (next: (s: unknown) => void, error?: (e: unknown) => void) => {
        try {
          return subscribe((s, m) => docSnap(path, s, m), next as (v: never) => void, error);
        } catch (e) {
          if (error) setTimeout(() => error(e), 0);
          return () => {};
        }
      },
      collection: (sub: string) => collRef(path + "/" + sub),
    };
  }

  function makeQuery(spec: QSpec): unknown {
    return {
      where: (f: string, op: string, v: unknown) => {
        if (spec.filters.length >= 10) throw err("invalid_argument", "too many filters");
        return makeQuery({ ...spec, filters: [...spec.filters, [f, op, v]] });
      },
      orderBy: (f: string, dir: "asc" | "desc" = "asc") => makeQuery({ ...spec, order: [f, dir] }),
      limit: (n: number) => {
        if (!(n >= 1 && n <= 1000)) throw err("invalid_argument", "limit must be 1-1000");
        return makeQuery({ ...spec, lim: n });
      },
      get: () => Promise.resolve(runQuery(spec, load())),
      onSnapshot: (next: (s: unknown) => void, error?: (e: unknown) => void) => {
        try {
          return subscribe((s, m) => runQuery(spec, s, m), next as (v: never) => void, error);
        } catch (e) {
          if (error) setTimeout(() => error(e), 0);
          return () => {};
        }
      },
    };
  }

  function collRef(path: string): unknown {
    const p = segs(path);
    if (p.length % 2 !== 1) throw new TypeError("collection paths need an odd number of segments: " + path);
    const q = makeQuery({ coll: path, filters: [], order: null, lim: null }) as Record<string, unknown>;
    let n = 0;
    const mint = () => "fk" + Date.now().toString(36) + (n++).toString(36) + Math.random().toString(36).slice(2, 6);
    return Object.assign(q, {
      path,
      doc: (id?: string) => docRef(path + "/" + (id ?? mint())),
      add: async (data: Record<string, unknown>) => {
        const ref = docRef(path + "/" + mint()) as { set: (d: unknown) => Promise<void> };
        await ref.set(data);
        return ref;
      },
    });
  }

  const db = Object.freeze({ doc: docRef, collection: collRef });

  /* ------------------------------------------------------------------ */
  /* user + downloads                                                    */
  /* ------------------------------------------------------------------ */
  const dir = arg.directory;
  function profile(id: string) {
    const p = dir.find((x) => x.id === id);
    return {
      id,
      name: p ? p.name : "",
      avatarUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='26' height='26'/%3E",
      color: "#888888",
      email: p?.email ?? null,
      isMe: !!viewer && viewer.uid === id,
      guest: false,
    };
  }
  const rootLevels = levelsFor("probe/doc");
  const user = Object.freeze({
    isOwner: async () => viewer?.level === "owner",
    canEdit: async () => !!viewer && myLevel >= ORDER.admin!,
    can: async (name: string) => {
      if (!viewer) return null;
      if (name === "data.write") return arg.canWrite !== undefined ? arg.canWrite : meets(rootLevels!.write);
      return false;
    },
    id: async () => viewer?.uid ?? null,
    me: async () => ({
      id: viewer?.uid ?? null,
      name: viewer?.name ?? "",
      avatarUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
      color: "#888888",
      email: viewer?.email ?? null,
      isOwner: viewer?.level === "owner",
      canEdit: !!viewer && myLevel >= ORDER.admin!,
    }),
    name: async () => viewer?.name ?? "",
    avatarUrl: async () => null,
    email: async () => viewer?.email ?? null,
    profiles: async (ids: string[] | string) => {
      const list = Array.isArray(ids) ? ids : [ids];
      const out: Record<string, unknown> = {};
      for (const id of list) out[id] = profile(id);
      return out;
    },
    search: async (q: string) => {
      const s = q.trim().toLowerCase();
      if (!s) return viewer?.uid ? [profile(viewer.uid)] : [];
      return dir.filter((p) => p.name.toLowerCase().includes(s) || (p.email || "").toLowerCase().includes(s)).slice(0, 8).map((p) => profile(p.id));
    },
  });

  const saved: { filename: string; data: string }[] = [];
  const downloads = Object.freeze({
    save: async (o: { filename: string; data: string | Blob }) => {
      saved.push({ filename: o.filename, data: typeof o.data === "string" ? o.data : "[blob]" });
    },
  });

  const caps: Record<string, unknown> = { db, user, downloads };
  g.claude = Object.freeze({
    use: (name: string) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(disabled.has(name as "db") || !viewer && name === "db" ? null : (caps[name] ?? null)), 5);
      }),
  });
  g.__fake = {
    writeLog, saved, load, levelsFor, canRead, canWriteDoc,
    subscriptions: () => listeners.size,
    revoke: () => { revoked = true; for (const sink of [...errorSinks]) sink(err("revoked", "access withdrawn")); },
    fail: (code: string, pathPrefix: string) => faults.push({ code, pathPrefix }),
  };
}
