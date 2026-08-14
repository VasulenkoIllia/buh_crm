import { describe, expect, it } from "vitest";
import { campaignRhythm } from "./schema/enums.js";
import {
  firstDateOf,
  firstRunOn,
  nextDateAfter,
  nextRunAfter,
  periodKeyOf,
  RHYTHM_LABELS,
} from "./campaigns.js";

const day = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().slice(0, 10));

describe("when a campaign fires next", () => {
  it("has no next date for a one-off", () => {
    expect(nextRunAfter(day("2026-09-01"), "once", day("2026-09-01"))).toBeNull();
  });

  it("steps a month, a quarter and a year", () => {
    const anchor = day("2026-09-10");
    expect(iso(nextRunAfter(anchor, "monthly", day("2026-09-10")))).toBe("2026-10-10");
    expect(iso(nextRunAfter(anchor, "quarterly", day("2026-09-10")))).toBe("2026-12-10");
    expect(iso(nextRunAfter(anchor, "yearly", day("2026-09-10")))).toBe("2027-09-10");
  });

  /**
   * The bug this exists to prevent: adding a month to each result in turn walks the date backwards
   * forever. The 31st becomes the 28th in February, and every month after that is the 28th — so a
   * campaign the firm set for month-end silently becomes a campaign for the 28th.
   */
  it("counts from the anchor, so a month-end date survives February", () => {
    const anchor = day("2026-01-31");
    expect(iso(nextRunAfter(anchor, "monthly", day("2026-01-31")))).toBe("2026-02-28");
    // …and the very next one is the 31st again, not the 28th
    expect(iso(nextRunAfter(anchor, "monthly", day("2026-02-28")))).toBe("2026-03-31");
    expect(iso(nextRunAfter(anchor, "monthly", day("2026-03-31")))).toBe("2026-04-30");
    expect(iso(nextRunAfter(anchor, "monthly", day("2026-04-30")))).toBe("2026-05-31");
  });

  it("finds February 29th in a leap year", () => {
    const anchor = day("2027-01-31");
    expect(iso(nextRunAfter(anchor, "monthly", day("2028-01-31")))).toBe("2028-02-29");
  });

  /**
   * A late run must not drag a backlog behind it. Asking from TODAY rather than from the date that
   * was missed is what makes a server down for five months send one letter, not five.
   */
  it("skips straight past everything missed when asked from today", () => {
    const anchor = day("2026-01-15");
    expect(iso(nextRunAfter(anchor, "monthly", day("2026-06-20")))).toBe("2026-07-15");
  });

  it("stops at the end date instead of running forever", () => {
    const anchor = day("2026-09-01");
    expect(iso(nextRunAfter(anchor, "monthly", day("2026-09-01"), day("2026-11-30")))).toBe(
      "2026-10-01",
    );
    expect(nextRunAfter(anchor, "monthly", day("2026-11-01"), day("2026-11-30"))).toBeNull();
  });

  it("never returns the date it was asked from", () => {
    const anchor = day("2026-09-01");
    for (const from of ["2026-09-01", "2026-10-01", "2027-02-01"]) {
      const next = nextRunAfter(anchor, "monthly", day(from));
      expect(next).not.toBeNull();
      expect(next!).toBeGreaterThan(day(from));
    }
  });
});

describe("the first run", () => {
  it("keeps a past start date, so a late campaign still goes out", () => {
    expect(iso(firstRunOn(day("2026-01-01")))).toBe("2026-01-01");
  });

  it("has no first run at all when it would already be over", () => {
    expect(firstRunOn(day("2026-12-01"), day("2026-11-30"))).toBeNull();
  });
});

describe("the occurrence key", () => {
  it("names the calendar day, which is what makes a double run impossible", () => {
    expect(periodKeyOf(day("2026-09-01"))).toBe("2026-09-01");
  });
});

describe("a hand-picked list of days", () => {
  const dates = [day("2026-09-15"), day("2026-03-15"), day("2026-04-15")];

  it("answers with the earliest day still ahead, whatever order they were typed", () => {
    expect(iso(firstDateOf(dates))).toBe("2026-03-15");
    expect(iso(nextDateAfter(dates, day("2026-01-01")))).toBe("2026-03-15");
    expect(iso(nextDateAfter(dates, day("2026-03-15")))).toBe("2026-04-15");
    expect(iso(nextDateAfter(dates, day("2026-04-15")))).toBe("2026-09-15");
  });

  it("runs out rather than repeating", () => {
    expect(nextDateAfter(dates, day("2026-09-15"))).toBeNull();
    expect(firstDateOf([])).toBeNull();
  });

  it("never returns the day it was asked from", () => {
    for (const from of dates) expect(nextDateAfter(dates, from)).not.toBe(from);
  });

  it("has no rhythm arithmetic — a dates campaign is never projected forward", () => {
    expect(nextRunAfter(day("2026-03-15"), "dates", day("2026-03-15"))).toBeNull();
  });
});

/**
 * `CampaignRhythm` is declared twice — a zod enum for validation, and a plain union here so this
 * module stays zod-free and out of the browser bundle. That duplication is deliberate; the two
 * silently disagreeing is not, and adding a value to one is exactly the moment it happens.
 */
describe("the two declarations of the rhythm", () => {
  it("cover the same values", () => {
    expect(Object.keys(RHYTHM_LABELS).sort()).toEqual([...campaignRhythm.options].sort());
  });
});
