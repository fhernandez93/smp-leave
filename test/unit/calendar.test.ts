import { describe, expect, it } from "vitest";
import { Calendar, DEFAULT_SETTINGS } from "../../src/domain/calendar";
import { countedDays, daysInYear, totalDays } from "../../src/domain/counting";
import { easter, fmtRange, isISODate, iso, num } from "../../src/domain/dates";
import type { Settings } from "../../src/domain/types";

const cal = (over: Partial<Settings> = {}) => new Calendar({ ...DEFAULT_SETTINGS, ...over });
const leave = (start: string, end: string, halfStart = false, halfEnd = false) => ({ start, end, halfStart, halfEnd });

describe("easter", () => {
  it.each([
    [2024, "2024-03-31"],
    [2025, "2025-04-20"],
    [2026, "2026-04-05"],
    [2027, "2027-03-28"],
    [2028, "2028-04-16"],
  ])("%i is %s", (y, expected) => {
    expect(iso(easter(y))).toBe(expected);
  });
});

describe("Fribourg holidays", () => {
  it("lists the movable feasts relative to Easter for 2026", () => {
    const h = cal().holidaysFor(2026);
    expect(h.get("2026-04-03")?.key).toBe("goodfriday");
    expect(h.get("2026-04-06")?.key).toBe("eastermonday");
    expect(h.get("2026-05-14")?.key).toBe("ascension");
    expect(h.get("2026-05-25")?.key).toBe("whitmonday");
    expect(h.get("2026-06-04")?.key).toBe("corpuschristi");
  });

  it("gives 1 May as an afternoon only", () => {
    const c = cal();
    expect(c.holidayFraction("2026-05-01")).toBe(0.5);
    expect(c.holidayLabel("2026-05-01")).toBe("Labour Day, afternoon off");
  });

  it("uses the published year-end table: 2026 half 24th, 31st normal; 2027 both full", () => {
    const c = cal();
    expect(c.holidayFraction("2026-12-24")).toBe(0.5);
    expect(c.holidayFraction("2026-12-31")).toBe(0);
    expect(c.holidayFraction("2027-12-24")).toBe(1);
    expect(c.holidayFraction("2027-12-31")).toBe(1);
  });

  it("falls back for unpublished years and lets settings override them", () => {
    expect(cal().holidayFraction("2028-12-24")).toBe(0.5);
    expect(cal({ yearEnd: { "2028": { dec24: 1, dec31: 1 } } }).holidayFraction("2028-12-31")).toBe(1);
  });

  it("drops holidays that are switched off and adds custom closures", () => {
    const c = cal({
      holidays: DEFAULT_SETTINGS.holidays.filter((k) => k !== "assumption"),
      customHolidays: [{ date: "2026-07-10", name: "Institute retreat", half: false }, { date: "2026-07-17", name: "", half: true }],
    });
    expect(c.holiday("2026-08-15")).toBeNull();
    expect(c.holiday("2026-07-10")?.name).toBe("Institute retreat");
    expect(c.holiday("2026-07-17")).toMatchObject({ name: "Office closed", fraction: 0.5 });
  });
});

describe("countedDays", () => {
  it("skips weekends and full holidays", () => {
    // Mon 21 Dec 2026 – Sun 3 Jan 2027: 24th half, 25th+26th(Sat) off, 31st normal in 2026, 1st+2nd(Sat) off
    const c = cal();
    const days = countedDays(c, leave("2026-12-21", "2027-01-03"));
    expect(days.map((d) => d.date)).toEqual(["2026-12-21", "2026-12-22", "2026-12-23", "2026-12-24", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31"]);
    expect(totalDays(c, leave("2026-12-21", "2027-01-03"))).toBe(7.5);
  });

  it("caps a half-day booking on a half holiday at 0.5, never below", () => {
    const c = cal();
    expect(totalDays(c, leave("2026-05-01", "2026-05-01", true))).toBe(0.5);
    expect(totalDays(c, leave("2026-05-01", "2026-05-01"))).toBe(0.5);
  });

  it("applies half start and half end on ranges", () => {
    const c = cal();
    expect(totalDays(c, leave("2026-03-02", "2026-03-06", true, true))).toBe(4);
    // halfEnd is ignored for single-day bookings
    expect(totalDays(c, leave("2026-03-02", "2026-03-02", false, true))).toBe(1);
  });

  it("splits a cross-year request by year", () => {
    const c = cal();
    const r = leave("2026-12-28", "2027-01-08");
    expect(daysInYear(c, r, 2026)).toBe(4);
    expect(daysInYear(c, r, 2027)).toBe(5); // 1 Jan off, 2/3 weekend, 4–8 Jan
  });

  it("returns nothing for reversed or malformed ranges", () => {
    const c = cal();
    expect(countedDays(c, leave("2026-03-06", "2026-03-02"))).toEqual([]);
    expect(countedDays(c, leave("garbage", "2026-03-02"))).toEqual([]);
  });

  it("follows custom workdays", () => {
    const c = cal({ workdays: [1, 2, 3, 4] });
    expect(totalDays(c, leave("2026-03-02", "2026-03-08"))).toBe(4);
  });
});

describe("formatting helpers", () => {
  it("formats numbers and ranges like v1", () => {
    expect(num(2)).toBe("2");
    expect(num(2.5)).toBe("2.5");
    expect(fmtRange("2026-11-20", "2026-11-27")).toBe("20 Nov – 27 Nov 2026");
    expect(fmtRange("2026-12-28", "2027-01-08")).toBe("28 Dec 2026 – 8 Jan 2027");
  });

  it("validates ISO dates strictly", () => {
    expect(isISODate("2026-02-28")).toBe(true);
    expect(isISODate("2026-02-30")).toBe(false);
    expect(isISODate("2026-2-3")).toBe(false);
    expect(isISODate(20260203)).toBe(false);
  });
});
