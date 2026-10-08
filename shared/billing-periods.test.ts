import { describe, expect, it } from "vitest";
import {
  billingDayProblem,
  invoiceAmount,
  periodLabel,
  periodRange,
  weekKey,
} from "./billing-periods.js";

describe("what a period key stands for", () => {
  it("reads a month, February of a leap year included", () => {
    expect(periodRange("2026-10")).toEqual({
      start: { y: 2026, m: 10, d: 1 },
      end: { y: 2026, m: 10, d: 31 },
    });
    expect(periodRange("2028-02")?.end).toEqual({ y: 2028, m: 2, d: 29 });
  });

  it("reads a quarter and a year", () => {
    expect(periodRange("2026-Q4")).toEqual({
      start: { y: 2026, m: 10, d: 1 },
      end: { y: 2026, m: 12, d: 31 },
    });
    expect(periodRange("2026-Q1")?.end).toEqual({ y: 2026, m: 3, d: 31 });
    expect(periodRange("2026")).toEqual({
      start: { y: 2026, m: 1, d: 1 },
      end: { y: 2026, m: 12, d: 31 },
    });
  });

  it("knows nothing of a key no rhythm writes", () => {
    for (const key of ["", "2026-13", "2026-Q5", "26-10", "2026-10-01", "oct"]) {
      expect(periodRange(key)).toBeNull();
    }
  });

  it("reads the halves of a month, February's second one short", () => {
    expect(periodRange("2026-10-H1")).toEqual({
      start: { y: 2026, m: 10, d: 1 },
      end: { y: 2026, m: 10, d: 15 },
    });
    expect(periodRange("2026-10-H2")).toEqual({
      start: { y: 2026, m: 10, d: 16 },
      end: { y: 2026, m: 10, d: 31 },
    });
    expect(periodRange("2027-02-H2")?.end).toEqual({ y: 2027, m: 2, d: 28 });
    expect(periodRange("2026-10-H3")).toBeNull();
  });

  it("reads an ISO week, Monday to Sunday, across the turn of a year", () => {
    expect(periodRange("2026-W41")).toEqual({
      start: { y: 2026, m: 10, d: 5 },
      end: { y: 2026, m: 10, d: 11 },
    });
    // week 1 of 2026 starts in 2025: it is the week holding 4 January
    expect(periodRange("2026-W01")?.start).toEqual({ y: 2025, m: 12, d: 29 });
    // 2026 has 53 weeks, 2027 has 52
    expect(periodRange("2026-W53")?.end).toEqual({ y: 2027, m: 1, d: 3 });
    expect(periodRange("2027-W53")).toBeNull();
    expect(periodRange("2026-W00")).toBeNull();
  });

  it("writes a week's key the way it reads it", () => {
    expect(weekKey({ y: 2026, m: 10, d: 7 })).toBe("2026-W41");
    expect(weekKey({ y: 2025, m: 12, d: 31 })).toBe("2026-W01");
    expect(weekKey({ y: 2027, m: 1, d: 3 })).toBe("2026-W53");
  });
});

describe("what one invoice bills", () => {
  it("bills the price, whatever the rhythm, except twice a month", () => {
    for (const period of ["week", "month", "quarter", "year"] as const) {
      expect(invoiceAmount(period, 90_000, "any")).toBe(90_000);
    }
  });

  it("splits a monthly price in halves that add up to it, the odd cent second", () => {
    expect(invoiceAmount("half_month", 90_000, "2026-10-H1")).toBe(45_000);
    expect(invoiceAmount("half_month", 90_000, "2026-10-H2")).toBe(45_000);
    expect(invoiceAmount("half_month", 90_001, "2026-10-H1")).toBe(45_000);
    expect(invoiceAmount("half_month", 90_001, "2026-10-H2")).toBe(45_001);
  });
});

describe("a subscription's billing day", () => {
  it("is a day of the week for a week, and only at the start of the period", () => {
    expect(billingDayProblem("week", "on_period_start", 5)).toBeNull();
    expect(billingDayProblem("week", "on_period_start", 8)).toBe("Pick a day of the week");
    expect(billingDayProblem("week", "on_period_start", 20)).toBe("Pick a day of the week");
    expect(billingDayProblem("month", "on_period_end", 5)).toMatch(/start of the period/);
  });

  it("is a day of the month otherwise, and none at all twice a month", () => {
    expect(billingDayProblem("month", "on_period_start", 20)).toBeNull();
    expect(billingDayProblem("quarter", "on_period_start", 31)).toBeNull();
    expect(billingDayProblem("half_month", "on_period_start", 5)).toMatch(
      /15th and the last day/,
    );
    expect(billingDayProblem("half_month", null, null)).toBeNull();
    expect(billingDayProblem("week", null, null)).toBeNull();
  });
});

describe("a period as a person reads it", () => {
  it("names a month, a quarter and a year", () => {
    expect(periodLabel("2026-10")).toBe("Oct 2026");
    expect(periodLabel("2026-Q4")).toBe("Q4 2026");
    expect(periodLabel("2026")).toBe("2026");
  });

  it("gives the days of a half and of a week", () => {
    expect(periodLabel("2026-10-H1")).toBe("1–15 Oct 2026");
    expect(periodLabel("2026-10-H2")).toBe("16–31 Oct 2026");
    expect(periodLabel("2027-02-H2")).toBe("16–28 Feb 2027");
    expect(periodLabel("2026-W41")).toBe("5–11 Oct 2026");
  });

  it("names both ends of a week across two months or two years", () => {
    expect(periodLabel("2026-W40")).toBe("28 Sep – 4 Oct 2026");
    expect(periodLabel("2026-W01")).toBe("29 Dec 2025 – 4 Jan 2026");
  });

  it("shows a key no rhythm writes as it is", () => {
    expect(periodLabel("once")).toBe("once");
    expect(periodLabel("2026-13")).toBe("2026-13");
  });
});
