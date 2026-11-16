import type { Calendar } from "./calendar";
import { addDays, iso, parseISO, yearOf } from "./dates";
import type { ISODate, LeaveEntry } from "./types";

export type LeaveShape = Pick<LeaveEntry, "start" | "end" | "halfStart" | "halfEnd">;

export interface CountedDay {
  date: ISODate;
  /** working-day weight, 0.5 or 1 */
  w: number;
}

/** Longest range we will ever walk (guards against corrupt data). */
const MAX_SPAN_DAYS = 1200;

/**
 * The working days a request actually consumes.
 * Weekends cost nothing, a closed day costs nothing, and a day the State
 * gives half off costs at most half. A half-day booking caps the day at
 * 0.5 rather than subtracting it, so booking the free morning of
 * 1 May still costs 0.5 and never less than zero.
 */
export function countedDays(cal: Calendar, req: LeaveShape): CountedDay[] {
  const out: CountedDay[] = [];
  if (!req.start || !req.end) return out;
  let d = parseISO(req.start);
  const end = parseISO(req.end);
  if (Number.isNaN(d.getTime()) || Number.isNaN(end.getTime()) || end < d) return out;
  let guard = 0;
  while (d <= end && guard++ < MAX_SPAN_DAYS) {
    const s = iso(d);
    if (cal.isWorkday(d)) {
      const avail = 1 - cal.holidayFraction(s);
      if (avail > 0) out.push({ date: s, w: avail });
    }
    d = addDays(d, 1);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (!first || !last) return out;
  const single = req.start === req.end;
  if (req.halfStart && first.date === req.start) first.w = Math.min(first.w, 0.5);
  if (req.halfEnd && !single && last.date === req.end) last.w = Math.min(last.w, 0.5);
  return out.filter((x) => x.w > 0);
}

export function totalDays(cal: Calendar, req: LeaveShape): number {
  return countedDays(cal, req).reduce((a, x) => a + x.w, 0);
}

export function daysInYear(cal: Calendar, req: LeaveShape, year: number): number {
  return countedDays(cal, req).reduce((a, x) => a + (yearOf(x.date) === year ? x.w : 0), 0);
}

export function weightOn(cal: Calendar, req: LeaveShape, date: ISODate): number {
  if (date < req.start || date > req.end) return 0;
  return countedDays(cal, req).find((c) => c.date === date)?.w ?? 0;
}
