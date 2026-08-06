import { beforeAll, describe, expect, it } from "vitest";
import {
  firmIsoDay,
  firmMinutesOfDay,
  firmWallClockToInstant,
  instantToFirmWallClock,
  setFirmTimezone,
} from "./tz.js";

/**
 * These run on a machine in Europe/Kyiv but assert New York answers — which is the point. Every
 * one of them passes trivially if the code accidentally uses the viewer's clock and the two zones
 * happen to agree, so the fixtures deliberately straddle the places where they do not.
 */
beforeAll(() => {
  setFirmTimezone("America/New_York");
});

describe("the firm's clock", () => {
  it("reads an instant on the firm's wall clock, not the viewer's", () => {
    // 2026-08-19T13:00Z is 09:00 in New York (EDT, −04:00) and 16:00 in Kyiv
    const at = new Date("2026-08-19T13:00:00.000Z");
    expect(firmMinutesOfDay(at)).toBe(9 * 60);
    expect(firmIsoDay(at)).toBe("2026-08-19");
  });

  it("puts a late-evening New York instant on ITS day, not the next one", () => {
    // 23:30 on the 19th in New York is 03:30 on the 20th UTC — and 06:30 on the 20th in Kyiv
    const at = new Date("2026-08-20T03:30:00.000Z");
    expect(firmIsoDay(at)).toBe("2026-08-19");
    expect(firmMinutesOfDay(at)).toBe(23 * 60 + 30);
  });

  it("handles winter, when New York is −05:00", () => {
    const at = new Date("2026-01-15T14:00:00.000Z"); // 09:00 EST
    expect(firmMinutesOfDay(at)).toBe(9 * 60);
    expect(firmIsoDay(at)).toBe("2026-01-15");
  });

  it("turns a typed wall clock into the instant the firm means", () => {
    // typing 09:00 in the office must mean 09:00 in the office, whoever is typing
    expect(firmWallClockToInstant("2026-08-19T09:00").toISOString()).toBe(
      "2026-08-19T13:00:00.000Z", // EDT
    );
    expect(firmWallClockToInstant("2026-01-15T09:00").toISOString()).toBe(
      "2026-01-15T14:00:00.000Z", // EST
    );
  });

  it("round-trips a wall clock through an instant and back", () => {
    for (const local of [
      "2026-08-19T09:00",
      "2026-01-15T23:45",
      "2026-03-09T12:00", // the day after the spring change
      "2026-11-02T12:00", // the day after the autumn change
    ]) {
      expect(instantToFirmWallClock(firmWallClockToInstant(local))).toBe(local);
    }
  });

  it("survives the spring-forward gap without landing a day out", () => {
    // New York springs forward at 02:00 on 8 March 2026; 03:00 that day is the first real hour
    const instant = firmWallClockToInstant("2026-03-08T03:00");
    expect(firmIsoDay(instant)).toBe("2026-03-08");
    expect(firmMinutesOfDay(instant)).toBe(3 * 60);
  });

  it("follows a change of firm zone", () => {
    const at = new Date("2026-08-19T13:00:00.000Z");
    setFirmTimezone("Europe/Kyiv");
    expect(firmMinutesOfDay(at)).toBe(16 * 60); // 16:00 in Kyiv
    setFirmTimezone("America/New_York");
    expect(firmMinutesOfDay(at)).toBe(9 * 60);
  });
});
