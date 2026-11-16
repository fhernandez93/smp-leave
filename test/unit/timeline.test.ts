import { describe, expect, it } from "vitest";
import { initials, personColors, PERSON_COLORS } from "../../src/domain/colors";
import { datesBetween, isoWeek, mondayOf, weekForMonth, weekInMonth } from "../../src/domain/dates";
import { member } from "./helpers";

describe("weeks", () => {
  it("finds the Monday of a week", () => {
    expect(mondayOf("2026-03-02")).toBe("2026-03-02");
    expect(mondayOf("2026-03-08")).toBe("2026-03-02");
    expect(mondayOf("2026-01-01")).toBe("2025-12-29");
  });

  it("numbers weeks the ISO way across New Year", () => {
    expect(isoWeek("2026-03-02")).toBe(10);
    expect(isoWeek("2025-12-29")).toBe(1); // Thursday is 1 Jan 2026
    expect(isoWeek("2026-12-31")).toBe(53);
    expect(isoWeek("2027-01-03")).toBe(53);
    expect(isoWeek("2027-01-04")).toBe(1);
  });

  it("puts a week in the month of its Thursday", () => {
    expect(weekInMonth("2025-12-29", 2026, 0)).toBe(true);
    expect(weekInMonth("2025-12-29", 2025, 11)).toBe(false);
    expect(weekInMonth("2026-03-30", 2026, 3)).toBe(true); // Thu 2 Apr
  });

  it("picks the week to show for a month", () => {
    // remembered week inside the month wins
    expect(weekForMonth(2026, 2, "2026-03-02", "2026-03-16")).toBe("2026-03-16");
    // otherwise today's week, whenever today is in the month
    expect(weekForMonth(2026, 2, "2026-03-02", null)).toBe("2026-03-02");
    expect(weekForMonth(2026, 2, "2026-03-02", "2026-04-06")).toBe("2026-03-02");
    expect(weekForMonth(2026, 2, "2026-03-30", null)).toBe("2026-03-30");
    // …even when today's week belongs to the previous month (Sun 1 Nov 2026, Fri 1 Jan 2027)
    expect(weekForMonth(2026, 10, "2026-11-01", null)).toBe("2026-10-26");
    expect(weekForMonth(2027, 0, "2027-01-01", null)).toBe("2026-12-28");
    // a different month shows its first week (the first whose Thursday is in it)
    expect(weekForMonth(2026, 3, "2026-03-02", null)).toBe("2026-03-30");
    // a month starting on a Friday: its first week starts the Monday after
    expect(weekForMonth(2026, 4, "2026-11-16", null)).toBe("2026-05-04");
    // January 2026's first week starts in December 2025
    expect(weekForMonth(2026, 0, "2026-11-16", null)).toBe("2025-12-29");
  });

  it("lists the dates of a range", () => {
    expect(datesBetween("2025-12-30", "2026-01-02")).toEqual(["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"]);
    expect(datesBetween("2024-01-01", "2024-12-31")).toHaveLength(366);
    expect(datesBetween("2026-01-02", "2026-01-01")).toEqual([]);
  });
});

describe("person colours", () => {
  const at = (n: number) => `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`;
  const team = (n: number) => Array.from({ length: n }, (_, i) => member(`m_${i}`, { addedAt: at(i + 1) }));

  it("gives up to 12 active people distinct colours, in the order they were added", () => {
    const all = team(PERSON_COLORS);
    const c = personColors(all, all);
    expect(new Set(c.values()).size).toBe(PERSON_COLORS);
    expect(all.map((m) => c.get(m.id))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("doesn't recolour anyone when someone joins", () => {
    const before = team(5);
    const after = [...before, member("m_new", { addedAt: "2026-06-01T00:00:00Z" })];
    const a = personColors(before, before), b = personColors(after, after);
    for (const m of before) expect(b.get(m.id)).toBe(a.get(m.id));
    expect(b.get("m_new")).toBe(5);
  });

  it("keeps archived people's slots so the others keep theirs", () => {
    const all = team(4).map((m, i) => (i === 1 ? { ...m, archived: true } : m));
    const active = all.filter((m) => !m.archived);
    const c = personColors(all, active);
    expect(c.get("m_0")).toBe(0);
    expect(c.has("m_1")).toBe(false);
    expect(c.get("m_2")).toBe(2);
    expect(c.get("m_3")).toBe(3);
  });

  it("bumps a clash to the next free colour while there are free ones", () => {
    // 13 people ever, the first one archived: person 13 prefers slot 0, which is free again
    const all = team(13).map((m, i) => (i === 0 ? { ...m, archived: true } : m));
    const active = all.filter((m) => !m.archived);
    const c = personColors(all, active);
    expect(new Set(c.values()).size).toBe(PERSON_COLORS);
    // 13 people ever, someone else archived: person 13's slot 0 is taken, gets the freed slot 5
    const all2 = team(13).map((m, i) => (i === 5 ? { ...m, archived: true } : m));
    const c2 = personColors(all2, all2.filter((m) => !m.archived));
    expect(new Set(c2.values()).size).toBe(PERSON_COLORS);
    expect(c2.get("m_12")).toBe(5);
  });

  it("repeats colours only beyond 12 active people", () => {
    const all = team(14);
    const c = personColors(all, all);
    expect(c.size).toBe(14);
    expect(new Set(c.values()).size).toBe(PERSON_COLORS);
  });

  it("is the same whatever order the roster arrives in", () => {
    const all = team(6);
    const a = personColors(all, all), b = personColors([...all].reverse(), [...all].reverse());
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
  });

  it("sorts people without an added date first, then by id", () => {
    const all = [member("m_b", { addedAt: null }), member("m_a", { addedAt: null }), member("m_c", { addedAt: at(1) })];
    const c = personColors(all, all);
    expect([c.get("m_a"), c.get("m_b"), c.get("m_c")]).toEqual([0, 1, 2]);
  });
});

describe("initials", () => {
  it("takes the first and last word", () => {
    expect(initials("Alice Muster")).toBe("AM");
    expect(initials("Jean-Luc Picard")).toBe("JP");
    expect(initials("Ana María de la Cruz")).toBe("AC");
    expect(initials("bob")).toBe("B");
    expect(initials("élodie ürsel")).toBe("ÉÜ");
    expect(initials("  ")).toBe("?");
    expect(initials("(Carol) Roth")).toBe("CR");
  });
});
