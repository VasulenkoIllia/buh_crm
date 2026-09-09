import { describe, expect, it } from "vitest";
import { ACTIVITY_EVENTS, type ActivityKey } from "./activity.js";
import { CHANGE_KIND, fieldLabel, formatChangeValue } from "./activity-format.js";

/**
 * **The screen must not show a person the database's own units.**
 *
 * Every case here is one that reached production on 2026-09-09 and was read by the owner as wrong.
 */
describe("change values, as a person reads them", () => {
  it("shows money as money — the payment of a hundred that read as ten thousand", () => {
    expect(formatChangeValue("amount", 10000)).toBe("$100.00");
    expect(formatChangeValue("amount", 0)).toBe("$0.00");
    expect(formatChangeValue("defaultAmount", 125050)).toBe("$1,250.50");
  });

  it("shows a timestamp as the day it was", () => {
    expect(formatChangeValue("paidAt", "2026-09-08T00:00:00.000Z")).toBe("2026-09-08");
    // already a day: left exactly as it is, not re-parsed through a timezone
    expect(formatChangeValue("deadline", "2026-09-09")).toBe("2026-09-09");
  });

  it("shows durations and sizes in the units they were meant in", () => {
    expect(formatChangeValue("minutes", 90)).toBe("1 h 30 m");
    expect(formatChangeValue("plannedMinutes", 120)).toBe("2 h");
    expect(formatChangeValue("seconds", 3600)).toBe("1 h");
    expect(formatChangeValue("bytes", 2048)).toBe("2 KB");
  });

  it("has an answer for every value two years of rows can hold", () => {
    expect(formatChangeValue("amount", null)).toBe("—");
    expect(formatChangeValue("anything", "")).toBe("—");
    expect(formatChangeValue("enabled", true)).toBe("yes");
    expect(formatChangeValue("enabled", false)).toBe("no");
    // a field nobody gave a kind renders as itself rather than as "[object Object]" or a crash
    expect(formatChangeValue("companyName", "Petrenko LLC")).toBe("Petrenko LLC");
    // a number written before `amount` had a kind is still a number
    expect(formatChangeValue("amount", "10000")).toBe("$100.00");
  });

  it("reads a list as a list", () => {
    // these hold NAMES now, and `String(array)` gave "Olena,Serhii" with no space — invisible
    // while they held uuids, obvious the moment they held people
    expect(formatChangeValue("assignees", ["Olena", "Serhii"])).toBe("Olena, Serhii");
    expect(formatChangeValue("added", [])).toBe("—");
    expect(formatChangeValue("removed", ["Olena"])).toBe("Olena");
  });

  it("turns a column name into words", () => {
    expect(fieldLabel("companyName")).toBe("company name");
    expect(fieldLabel("paidAt")).toBe("paid at");
    expect(fieldLabel("invoice_day")).toBe("invoice day");
  });
});

describe("the kind map and the registry agree", () => {
  it("gives a kind to every field whose name means a unit", () => {
    const declared = new Set<string>();
    for (const key of Object.keys(ACTIVITY_EVENTS) as ActivityKey[]) {
      for (const k of ACTIVITY_EVENTS[key].changeKeys ?? []) declared.add(k);
    }
    /**
     * The map is keyed by field name rather than by event, so a NEW event reusing `amount` is
     * formatted without anybody touching this file. What that cannot catch is a new field whose
     * name means a unit — `netAmount`, `expiresAt` — so the names are checked by shape here.
     */
    const unitLike = [...declared].filter(
      (k) =>
        /amount|balance$/i.test(k) || /(At|On|Date|deadline)$/.test(k) || /Minutes$/.test(k),
    );
    const missing = unitLike.filter((k) => !(k in CHANGE_KIND));
    expect(missing).toEqual([]);
  });

  it("names only fields the registry actually declares", () => {
    const declared = new Set<string>();
    for (const key of Object.keys(ACTIVITY_EVENTS) as ActivityKey[]) {
      for (const k of ACTIVITY_EVENTS[key].changeKeys ?? []) declared.add(k);
    }
    // a kind for a field nothing records is a rule about nothing — usually a rename left behind
    const orphans = Object.keys(CHANGE_KIND).filter((k) => !declared.has(k));
    expect(orphans).toEqual([]);
  });
});
