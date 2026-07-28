import { describe, expect, it } from "vitest";
import { fmtBizDate, fmtBizDay, fmtDate } from "./format";

/**
 * The off-by-one a user hit on 2026-07-27: a task saved with deadline 28.07 showed 27.07 on the
 * board — but only on a machine set to a timezone west of UTC. Business dates are stored at UTC
 * midnight, so rendering them in the viewer's local time walks them back a day for everyone at a
 * negative offset. `fmtBizDate`/`fmtBizDay` read the day off the UTC clock, so the answer here is
 * the same whatever timezone this suite runs in.
 */
describe("business dates format the same in every timezone", () => {
  const deadline = "2026-07-28T00:00:00.000Z"; // what the API returns for the day 28.07.2026

  it("prints the stored calendar day, not the viewer's", () => {
    expect(fmtBizDate(deadline)).toBe("28/07/2026");
    expect(fmtBizDay(deadline)).toBe("28/07");
  });

  it("agrees with the string the date input round-trips", () => {
    // the edit modal shows `deadline.slice(0, 10)`; the card must not disagree with it
    const [y, m, d] = deadline.slice(0, 10).split("-");
    expect(fmtBizDate(deadline)).toBe(`${d}/${m}/${y}`);
  });

  it("holds on both sides of a year boundary", () => {
    expect(fmtBizDate("2027-01-01T00:00:00.000Z")).toBe("01/01/2027");
    expect(fmtBizDate("2026-12-31T00:00:00.000Z")).toBe("31/12/2026");
  });

  it("leaves timestamps alone — those are instants and stay local", () => {
    // midday UTC lands on the same calendar day from UTC-11 to UTC+12, so this one assertion
    // is timezone-independent while still exercising the local-time formatter
    expect(fmtDate("2026-07-28T12:00:00.000Z")).toBe("28/07/2026");
  });
});
