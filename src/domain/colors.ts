import type { Member } from "./types";

/** Number of person colours (CSS tokens --p0 … --p11, light and dark). */
export const PERSON_COLORS = 12;

/**
 * A colour slot per active member, the same for every viewer.
 *
 * Members are ordered by when they were added (then id), archived ones included,
 * so each person keeps a stable preferred slot: adding someone never changes
 * anyone else's colour. Active members take their preferred slot, or the next
 * free one if it's taken, so up to PERSON_COLORS active people never share a colour.
 */
export function personColors(all: readonly Member[], active: readonly Member[], n = PERSON_COLORS): Map<string, number> {
  const order = [...all].sort((a, b) => (a.addedAt ?? "").localeCompare(b.addedAt ?? "") || a.id.localeCompare(b.id));
  const preferred = new Map(order.map((m, i) => [m.id, i % n]));
  const activeIds = new Set(active.map((m) => m.id));
  // someone active but missing from `all` (shouldn't happen) still gets a slot, after everyone else
  for (const m of active) if (!preferred.has(m.id)) { preferred.set(m.id, preferred.size % n); order.push(m); }
  const used = new Set<number>();
  const out = new Map<string, number>();
  for (const m of order) {
    if (!activeIds.has(m.id) || out.has(m.id)) continue;
    let c = preferred.get(m.id)!;
    if (used.size < n) while (used.has(c)) c = (c + 1) % n;
    used.add(c);
    out.set(m.id, c);
  }
  return out;
}

/** One or two initials for a badge: first letters of the first and last words. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s\-–—]+/u).filter((w) => /\p{L}|\p{N}/u.test(w));
  if (!words.length) return "?";
  const first = [...words[0]!].find((c) => /\p{L}|\p{N}/u.test(c)) ?? "";
  const last = words.length > 1 ? [...words[words.length - 1]!].find((c) => /\p{L}|\p{N}/u.test(c)) ?? "" : "";
  return (first + last).toLocaleUpperCase() || "?";
}
