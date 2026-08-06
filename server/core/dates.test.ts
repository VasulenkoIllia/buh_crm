import { describe, expect, it } from "vitest";
import { dateToUtc, isoDayInTz, zonedDayStart } from "./dates.js";

/**
 * The distinction this file exists to protect: a stored DATE is UTC midnight, a meeting is a real
 * instant. Slicing a day of meetings with `dateToUtc` looks right in a UTC test environment and is
 * three hours wrong in the office that actually uses this.
 */
describe("zonedDayStart", () => {
  it("starts a Kyiv day three hours before UTC midnight in summer (UTC+3)", () => {
    expect(zonedDayStart("2026-08-10", "Europe/Kyiv").toISOString()).toBe(
      "2026-08-09T21:00:00.000Z",
    );
  });

  it("starts it two hours before in winter (UTC+2)", () => {
    expect(zonedDayStart("2026-01-15", "Europe/Kyiv").toISOString()).toBe(
      "2026-01-14T22:00:00.000Z",
    );
  });

  it("lands on the right instant across the spring-forward night", () => {
    // Kyiv moves to UTC+3 on the last Sunday of March; the day AFTER still begins at 21:00 UTC
    expect(zonedDayStart("2026-03-30", "Europe/Kyiv").toISOString()).toBe(
      "2026-03-29T21:00:00.000Z",
    );
  });

  it("agrees with dateToUtc only in UTC itself", () => {
    expect(zonedDayStart("2026-08-10", "UTC").getTime()).toBe(dateToUtc("2026-08-10").getTime());
    expect(zonedDayStart("2026-08-10", "Europe/Kyiv").getTime()).not.toBe(
      dateToUtc("2026-08-10").getTime(),
    );
  });
});

describe("isoDayInTz", () => {
  it("puts an early-morning Kyiv instant on ITS day, not the day before", () => {
    // 00:30 on the 19th in Kyiv is 21:30 on the 18th in UTC — the naive slice reports the 18th
    const earlyMorning = new Date("2026-08-18T21:30:00.000Z");
    expect(earlyMorning.toISOString().slice(0, 10)).toBe("2026-08-18"); // what it used to do
    expect(isoDayInTz(earlyMorning, "Europe/Kyiv")).toBe("2026-08-19"); // what it must do
  });

  it("agrees with the naive reading for the rest of the day", () => {
    const midday = new Date("2026-08-19T07:00:00.000Z"); // 10:00 Kyiv
    expect(isoDayInTz(midday, "Europe/Kyiv")).toBe("2026-08-19");
  });

  it("handles the winter offset too (UTC+2)", () => {
    expect(isoDayInTz(new Date("2026-01-14T22:30:00.000Z"), "Europe/Kyiv")).toBe("2026-01-15");
  });
});
