import type { ISODate } from "./types";

/* All dates are UTC calendar dates written as ISO yyyy-mm-dd strings, as in v1. */

export const DAYMS = 86_400_000;
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
export const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== "string" || !ISO_RE.test(s)) return false;
  const d = parseISO(s);
  return !Number.isNaN(d.getTime()) && iso(d) === s;
}

export function iso(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function parseISO(s: string): Date {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(Date.UTC(y ?? NaN, (m ?? NaN) - 1, d ?? NaN));
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAYMS);
}

/** Today in the viewer's local calendar, as an ISO date. */
export function todayISO(now: Date = new Date()): ISODate {
  return iso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

export function yearOf(s: string): number {
  return Number(String(s).slice(0, 4));
}

function monthName(d: Date): string {
  return MON3[d.getUTCMonth()] ?? "";
}

export function fmtDate(s: ISODate): string {
  const d = parseISO(s);
  return `${d.getUTCDate()} ${monthName(d)} ${d.getUTCFullYear()}`;
}

export function fmtShort(s: ISODate): string {
  const d = parseISO(s);
  return `${d.getUTCDate()} ${monthName(d)}`;
}

export function fmtRange(a: ISODate, b: ISODate): string {
  if (a === b) return fmtDate(a);
  return yearOf(a) === yearOf(b) ? `${fmtShort(a)} – ${fmtDate(b)}` : `${fmtDate(a)} – ${fmtDate(b)}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

export function isLeap(y: number): boolean {
  return daysInMonth(y, 1) === 29;
}

/** 0 = Monday … 6 = Sunday */
export function mondayIndex(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

/** 1 decimal at most, no trailing ".0" — v1's number style. */
export function num(n: number): string {
  return Number(n).toFixed(1).replace(/\.0$/, "");
}

export function plural(n: number, one: string, many: string): string {
  return `${num(n)} ${Math.abs(n) === 1 ? one : many}`;
}

export function fmtHours(n: number): string {
  const v = Math.round(Number(n) * 100) / 100;
  return `${v} h`;
}

/** Easter Sunday (Meeus/Jones/Butcher, Gregorian). */
export function easter(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const hh = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - hh - k) % 7;
  const m = Math.floor((a + 11 * hh + 22 * l) / 451);
  const mo = Math.floor((hh + l - 7 * m + 114) / 31);
  const da = ((hh + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, mo - 1, da));
}

export function overlaps(a: { start: ISODate; end: ISODate }, b: { start: ISODate; end: ISODate }): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/* ---------- weeks (Monday-first; a week belongs to the month of its Thursday, as ISO 8601) ---------- */

/** The Monday of the week containing `s`. */
export function mondayOf(s: ISODate): ISODate {
  const d = parseISO(s);
  return iso(addDays(d, -mondayIndex(d)));
}

/** The Thursday of the week starting on `monday`: it decides the week's month and year. */
export function thursdayOf(monday: ISODate): Date {
  return addDays(parseISO(mondayOf(monday)), 3);
}

/** ISO 8601 week number. */
export function isoWeek(s: ISODate): number {
  const thu = thursdayOf(mondayOf(s));
  const jan1 = Date.UTC(thu.getUTCFullYear(), 0, 1);
  return Math.floor((thu.getTime() - jan1) / DAYMS / 7) + 1;
}

/** Does the week starting on `monday` belong to month `m` (0-based) of year `y`? */
export function weekInMonth(monday: ISODate, y: number, m: number): boolean {
  const t = thursdayOf(monday);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m;
}

/**
 * The week to show for a month: the remembered week if it belongs to that month,
 * else today's week if today is in that month (so "today" is always on screen,
 * even on the 1st of a month whose first days belong to the previous month's last week),
 * else the month's first week.
 */
export function weekForMonth(y: number, m: number, today: ISODate, remembered: ISODate | null): ISODate {
  if (remembered && weekInMonth(remembered, y, m)) return mondayOf(remembered);
  const t = parseISO(today);
  if (t.getUTCFullYear() === y && t.getUTCMonth() === m) return mondayOf(today);
  const first = new Date(Date.UTC(y, m, 1));
  const firstThu = addDays(first, (3 - mondayIndex(first) + 7) % 7);
  return iso(addDays(firstThu, -3));
}

/** Every date from `a` to `b` inclusive. */
export function datesBetween(a: ISODate, b: ISODate): ISODate[] {
  const out: ISODate[] = [];
  const end = parseISO(b).getTime();
  for (let d = parseISO(a); d.getTime() <= end && out.length < 400; d = addDays(d, 1)) out.push(iso(d));
  return out;
}
