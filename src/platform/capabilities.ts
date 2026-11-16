/**
 * The capabilities this page declares when published, including the db
 * access rules that are the app's server-side authorization layer.
 * This object is the single source of truth: it is passed to the Artifact
 * publish call (see scripts/capabilities.json, generated at build) and the
 * e2e fake runtime enforces exactly these rules.
 */

export type Level = "view" | "interact" | "admin" | "owner";
export interface Rule {
  path: string;
  read?: Level;
  write?: Level;
}

export const RULES: readonly Rule[] = [
  // root: everyone admitted reads; Contributors and up write (this is what can("data.write") reports)
  { path: "", read: "view", write: "interact" },
  // only Editors (and the owner) change these
  { path: "config", write: "admin" },
  { path: "members", write: "admin" },
  { path: "decisions", write: "admin" },
  { path: "archive", write: "admin" },
  // v1 collections: kept untouched as a backup, frozen for everyone below Editor
  { path: "requests", write: "admin" },
  { path: "overtime", write: "admin" },
  // each person writes only their own ledger; Editors write anyone's
  { path: "ledger", read: "view", write: "admin" },
  { path: "ledger/{self}", write: "interact" },
  // each person claims their own roster entry
  { path: "links", read: "view", write: "admin" },
  { path: "links/{self}", write: "interact" },
  // join requests: private to the asker, visible to Editors
  { path: "joiners", read: "admin", write: "admin" },
  { path: "joiners/{self}", read: "interact", write: "interact" },
  // private per-viewer profile (which roster entry is me)
  { path: "data/users/{self}", write: "interact" },
];

export const CAPABILITIES = {
  db: { rules: RULES },
  user: { scopes: ["profile"] },
  downloads: {},
} as const;

/** Top-level collections the app reads or writes; every one must be covered by an explicit rule. */
export const APP_COLLECTIONS = ["config", "members", "decisions", "archive", "ledger", "links", "joiners", "data"] as const;
