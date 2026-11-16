/**
 * Typed access to the claude.ai artifact runtime (contract 0.2.89).
 * Only the subset this app uses is typed; see the platform's db.d.ts /
 * user.d.ts / downloads.d.ts for the authoritative contract.
 */

export interface DbError { code: string; message: string }

export interface SnapshotMetadata { fromCache: boolean; hasPendingWrites: boolean }
export interface DocSnap { id: string; exists: boolean; data(): Record<string, unknown> | undefined; metadata: SnapshotMetadata }
export interface QuerySnap { docs: DocSnap[]; size: number; empty: boolean; metadata: SnapshotMetadata }
export type Unsubscribe = () => void;

export interface DocRef {
  id: string;
  path: string;
  get(): Promise<DocSnap>;
  set(data: Record<string, unknown>): Promise<void>;
  update(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  acquire?(o: { holder: string; ttlMs?: number }): Promise<{ acquired: boolean; expiresAt?: string }>;
  onSnapshot(next: (s: DocSnap) => void, error?: (e: DbError) => void): Unsubscribe;
  collection(path: string): CollRef;
}
export interface Query {
  where(field: string, op: string, value: unknown): Query;
  orderBy(field: string, dir?: "asc" | "desc"): Query;
  limit(n: number): Query;
  get(): Promise<QuerySnap>;
  onSnapshot(next: (s: QuerySnap) => void, error?: (e: DbError) => void): Unsubscribe;
}
export interface CollRef extends Query { path: string; doc(id?: string): DocRef }
export interface DB { doc(path: string): DocRef; collection(path: string): CollRef }

export interface Profile { id: string; name: string; avatarUrl: string; color: string; email: string | null; isMe: boolean; guest: boolean }
export interface Viewer { id: string | null; name: string; avatarUrl: string; color: string; email: string | null; isOwner: boolean; canEdit: boolean }
export interface User {
  isOwner(): Promise<boolean>;
  canEdit(): Promise<boolean>;
  can(name: string): Promise<boolean | null>;
  id(): Promise<string | null>;
  me(): Promise<Viewer>;
  profiles(ids: readonly string[]): Promise<Record<string, Profile>>;
  search(q: string): Promise<Profile[]>;
}
export interface Downloads { save(o: { filename: string; data: string | Blob }): Promise<void> }

export interface Runtime { db: DB | null; user: User | null; downloads: Downloads | null }

interface ClaudeGlobal { use(name: string): Promise<unknown> }

/** Wait for `window.claude` (the viewer injects it after our first script run), then resolve the capabilities. */
export async function connect(win: Window & { claude?: ClaudeGlobal } = window as Window & { claude?: ClaudeGlobal }): Promise<Runtime | null> {
  for (let i = 0; i < 40 && (!win.claude || typeof win.claude.use !== "function"); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const c = win.claude;
  if (!c || typeof c.use !== "function") return null;
  const safe = <T,>(name: string) => c.use(name).then((x) => (x ?? null) as T | null).catch(() => null);
  const [db, user, downloads] = await Promise.all([safe<DB>("db"), safe<User>("user"), safe<Downloads>("downloads")]);
  return { db, user, downloads };
}

export function errorCode(e: unknown): string {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "unknown";
}
