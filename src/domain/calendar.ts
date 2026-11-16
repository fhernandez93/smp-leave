import { addDays, easter, iso, parseISO, yearOf } from "./dates";
import type { ISODate, Settings, YearEndOverride } from "./types";

/* The calendar published for State of Fribourg employees by the Amt für
   Personal und Organisation (www.fr.ch). "Gesetzliche Feiertage" are fixed
   in law; "dienstfreie Tage" are granted on top of them, and the year-end
   ones are decided afresh every year, so only the years the State has
   actually published are authoritative here. */

export type HolidayKind = "legal" | "service" | "custom";

export interface HolidayDef {
  key: string;
  kind: "legal" | "service";
  name: string;
  de: string;
  fixed?: [number, number];
  easter?: number;
  fraction?: number;
  period?: "pm";
  yearly?: boolean;
}

export const HOLIDAY_DEFS: readonly HolidayDef[] = [
  { key: "newyear", kind: "legal", name: "New Year’s Day", de: "Neujahrstag", fixed: [1, 1] },
  { key: "goodfriday", kind: "legal", name: "Good Friday", de: "Karfreitag", easter: -2 },
  { key: "ascension", kind: "legal", name: "Ascension", de: "Auffahrt", easter: 39 },
  { key: "corpuschristi", kind: "legal", name: "Corpus Christi", de: "Fronleichnam", easter: 60 },
  { key: "nationalday", kind: "legal", name: "Swiss National Day", de: "Bundesfeiertag", fixed: [8, 1] },
  { key: "assumption", kind: "legal", name: "Assumption", de: "Mariä Himmelfahrt", fixed: [8, 15] },
  { key: "allsaints", kind: "legal", name: "All Saints", de: "Allerheiligen", fixed: [11, 1] },
  { key: "immaculate", kind: "legal", name: "Immaculate Conception", de: "Mariä Empfängnis", fixed: [12, 8] },
  { key: "christmas", kind: "legal", name: "Christmas Day", de: "Weihnachten", fixed: [12, 25] },
  { key: "berchtold", kind: "service", name: "Berchtold’s Day", de: "Berchtoldstag", fixed: [1, 2] },
  { key: "eastermonday", kind: "service", name: "Easter Monday", de: "Ostermontag", easter: 1 },
  { key: "labour", kind: "service", name: "Labour Day", de: "Tag der Arbeit", fixed: [5, 1], fraction: 0.5, period: "pm" },
  { key: "whitmonday", kind: "service", name: "Whit Monday", de: "Pfingstmontag", easter: 50 },
  { key: "dec24", kind: "service", name: "Christmas Eve", de: "24. Dezember", fixed: [12, 24], yearly: true, period: "pm" },
  { key: "ststephen", kind: "service", name: "St Stephen’s Day", de: "Stephanstag", fixed: [12, 26] },
  { key: "dec31", kind: "service", name: "New Year’s Eve", de: "31. Dezember", fixed: [12, 31], yearly: true, period: "pm" },
];

/** 24 and 31 December, exactly as the State published them. */
export const YEAR_END: Readonly<Record<number, Required<YearEndOverride>>> = {
  2026: { dec24: 0.5, dec31: 0 },
  2027: { dec24: 1, dec31: 1 },
};
export const YEAR_END_FALLBACK: Required<YearEndOverride> = { dec24: 0.5, dec31: 0 };
export const PUBLISHED_YEARS: readonly number[] = Object.keys(YEAR_END).map(Number);
export const DEFAULT_HOLIDAYS: readonly string[] = HOLIDAY_DEFS.map((d) => d.key);
export const HOLIDAY_VERSION = 2;

export const DEFAULT_SETTINGS: Settings = {
  teamName: "SMP Physics Team",
  defaultDays: 25,
  workdays: [1, 2, 3, 4, 5],
  approvalThreshold: 2,
  hoursPerDay: 8.4, // 42 h a week over five days, as the State sets it
  holidays: [...DEFAULT_HOLIDAYS],
  customHolidays: [],
  yearEnd: {},
  created: null,
  holidayVersion: HOLIDAY_VERSION,
  archivedBefore: null,
};

export interface Holiday {
  key: string;
  name: string;
  de: string;
  kind: HolidayKind;
  /** 1 = office shut, 0.5 = half the day free */
  fraction: number;
  period?: "pm";
}

export function holidayDate(def: HolidayDef, year: number): Date {
  return def.fixed ? new Date(Date.UTC(year, def.fixed[0] - 1, def.fixed[1])) : addDays(easter(year), def.easter ?? 0);
}

/**
 * Everything the working-day arithmetic needs from the settings, with a
 * per-year holiday cache. Build a new one whenever the settings change.
 */
export class Calendar {
  private readonly cache = new Map<number, Map<ISODate, Holiday>>();
  constructor(readonly settings: Settings) {}

  yearEndFor(year: number): Required<YearEndOverride> {
    return { ...(YEAR_END[year] ?? YEAR_END_FALLBACK), ...(this.settings.yearEnd[String(year)] ?? {}) } as Required<YearEndOverride>;
  }

  holidaysFor(year: number): Map<ISODate, Holiday> {
    const hit = this.cache.get(year);
    if (hit) return hit;
    const map = new Map<ISODate, Holiday>();
    const ye = this.yearEndFor(year);
    for (const def of HOLIDAY_DEFS) {
      if (!this.settings.holidays.includes(def.key)) continue;
      const frac = def.yearly ? Number(ye[def.key as keyof YearEndOverride] ?? 0) : (def.fraction ?? 1);
      if (!frac) continue;
      const h: Holiday = { key: def.key, name: def.name, de: def.de, kind: def.kind, fraction: frac };
      if (def.period) h.period = def.period;
      map.set(iso(holidayDate(def, year)), h);
    }
    for (const c of this.settings.customHolidays) {
      if (c.date && yearOf(c.date) === year) {
        map.set(c.date, { key: "custom", name: c.name || "Office closed", de: "", kind: "custom", fraction: c.half ? 0.5 : 1 });
      }
    }
    this.cache.set(year, map);
    return map;
  }

  holiday(date: ISODate): Holiday | null {
    return this.holidaysFor(yearOf(date)).get(date) ?? null;
  }

  /** 0 = an ordinary day, 0.5 = half the day is free, 1 = the office is shut. */
  holidayFraction(date: ISODate): number {
    return this.holiday(date)?.fraction ?? 0;
  }

  holidayLabel(date: ISODate): string | null {
    const x = this.holiday(date);
    if (!x) return null;
    return x.fraction < 1 ? `${x.name}, ${x.period === "pm" ? "afternoon off" : "half day off"}` : x.name;
  }

  isWorkday(d: Date | ISODate): boolean {
    const date = typeof d === "string" ? parseISO(d) : d;
    return this.settings.workdays.includes(date.getUTCDay());
  }

  hoursPerDay(): number {
    return Number(this.settings.hoursPerDay) || DEFAULT_SETTINGS.hoursPerDay;
  }
}
