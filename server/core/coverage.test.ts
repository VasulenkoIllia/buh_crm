import { describe, expect, it } from "vitest";
import { coverage, firstDayInForce, inForceOn, type InForcePeriod } from "./coverage.js";
import type { Day } from "./dates.js";

/**
 * Every scenario walked through with the user while agreeing the model (2026-07-29). These are the
 * cases the whole subscription/billing behaviour rests on, so they are pinned here rather than
 * left to the integration tests: if one of them changes, the change should be deliberate.
 */

const on = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const day = (iso: string): Day => {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
};
const period = (startsOn: string, endsBefore?: string): InForcePeriod => ({
  startsOn: on(startsOn),
  endsBefore: endsBefore ? on(endsBefore) : null,
});

const AUG_1 = day("2026-08-01");
const AUG_31 = day("2026-08-31");

describe("inForceOn", () => {
  const open = [period("2026-08-15")];

  it("starts ON the start day and not before", () => {
    expect(inForceOn(open, day("2026-08-14"))).toBe(false);
    expect(inForceOn(open, day("2026-08-15"))).toBe(true);
  });

  it("runs forever while the period is open — nothing expires a subscription", () => {
    expect(inForceOn(open, day("2030-01-01"))).toBe(true);
  });

  it("ends BEFORE endsBefore — pausing 'on the 20th' still serves the 20th", () => {
    const closed = [period("2026-08-01", "2026-08-21")];
    expect(inForceOn(closed, day("2026-08-20"))).toBe(true);
    expect(inForceOn(closed, day("2026-08-21"))).toBe(false);
  });

  it("a subscription scheduled to start later is not in force yet", () => {
    expect(inForceOn([period("2026-10-01")], day("2026-08-29"))).toBe(false);
  });

  it("has no periods at all → never in force", () => {
    expect(inForceOn([], day("2026-08-15"))).toBe(false);
  });
});

describe("coverage of a month", () => {
  it("open period that started earlier → the whole month", () => {
    expect(coverage([period("2026-06-01")], AUG_1, AUG_31)).toBe("full");
  });

  it("client arrives mid-month → partial, so it is invoiced by hand", () => {
    expect(coverage([period("2026-08-15")], AUG_1, AUG_31)).toBe("partial");
  });

  it("…and the NEXT month is whole again", () => {
    expect(coverage([period("2026-08-15")], day("2026-09-01"), day("2026-09-30"))).toBe("full");
  });

  it("paused mid-month → partial", () => {
    expect(coverage([period("2026-06-01", "2026-08-21")], AUG_1, AUG_31)).toBe("partial");
  });

  it("paused and resumed the SAME day → no gap, the month stays whole", () => {
    // this is the case a single 'in force since' field got wrong: a five-minute pause would have
    // cancelled the month's automatic invoice
    const periods = [period("2026-06-01", "2026-08-20"), period("2026-08-20")];
    expect(coverage(periods, AUG_1, AUG_31)).toBe("full");
  });

  it("exactly one day missing → partial", () => {
    const periods = [period("2026-06-01", "2026-08-20"), period("2026-08-21")];
    expect(coverage(periods, AUG_1, AUG_31)).toBe("partial");
    expect(inForceOn(periods, day("2026-08-20"))).toBe(false);
  });

  it("paused for the whole month → none, so nothing happens at all", () => {
    const periods = [period("2026-06-01", "2026-08-01"), period("2026-09-01")];
    expect(coverage(periods, AUG_1, AUG_31)).toBe("none");
  });

  it("a subscription that starts after the month → none", () => {
    expect(coverage([period("2026-10-01")], AUG_1, AUG_31)).toBe("none");
  });
});

describe("coverage through a trigger day (the billing rule)", () => {
  const resumedOnThe2nd = [period("2026-06-01", "2026-07-20"), period("2026-08-02")];

  it("prepay on the 1st: resumed on the 2nd → the 1st was not served, so no invoice", () => {
    expect(coverage(resumedOnThe2nd, AUG_1, AUG_1)).toBe("none");
  });

  it("prepay on the 1st: resumed ON the 1st → served, invoice goes out", () => {
    expect(coverage([period("2026-08-01")], AUG_1, AUG_1)).toBe("full");
  });

  it("prepay with a custom day 15: a gap anywhere in 1–15 blocks it", () => {
    const gap = [period("2026-06-01", "2026-08-10"), period("2026-08-12")];
    expect(coverage(gap, AUG_1, day("2026-08-15"))).toBe("partial");
  });

  it("postpay: paused on the 20th → the month is not whole, so the final invoice is manual", () => {
    expect(coverage([period("2026-06-01", "2026-08-21")], AUG_1, AUG_31)).toBe("partial");
  });
});

describe("firstDayInForce", () => {
  it("is the earliest start across every period, however they were entered", () => {
    const periods = [period("2026-08-02"), period("2026-06-01", "2026-07-20")];
    expect(firstDayInForce(periods)).toEqual({ y: 2026, m: 6, d: 1 });
  });

  it("is null when the subscription has no periods", () => {
    expect(firstDayInForce([])).toBeNull();
  });
});
