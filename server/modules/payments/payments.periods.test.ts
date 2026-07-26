import { describe, expect, it } from "vitest";
import { businessDateMs, isPastBusinessDate, isTaskOverdue } from "@shared/dates.js";
import { deriveStatus } from "@shared/schema/payment.js";
import { fromDate, todayBusinessMs } from "../../core/dates.js";
import { issueDayFor, periodsInWindow } from "./payments.generation.js";

// Pure billing-period math — the part of job #2 that decides WHICH period is billed and WHEN —
// plus the shared business-date rule that decides what "late" means for invoices AND tasks.

const day = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
};
const keys = (p: ReturnType<typeof periodsInWindow>) => p.map((x) => x.key);

describe("billing periods", () => {
  it("months run from the anchor's own month to today's", () => {
    const periods = periodsInWindow("month", day("2026-07-25"), day("2026-10-02"));
    expect(keys(periods)).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(periods[0].start).toEqual(day("2026-07-01"));
    expect(periods[0].end).toEqual(day("2026-07-31"));
  });

  it("months cross the year boundary", () => {
    expect(keys(periodsInWindow("month", day("2026-11-10"), day("2027-01-05")))).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
    ]);
  });

  it("quarters start at the anchor's quarter and span years correctly", () => {
    expect(keys(periodsInWindow("quarter", day("2026-05-04"), day("2027-02-01")))).toEqual([
      "2026-Q2",
      "2026-Q3",
      "2026-Q4",
      "2027-Q1",
    ]);
    const [q2] = periodsInWindow("quarter", day("2026-05-04"), day("2026-05-04"));
    expect(q2.start).toEqual(day("2026-04-01"));
    expect(q2.end).toEqual(day("2026-06-30"));
  });

  it("years are one period each", () => {
    const years = periodsInWindow("year", day("2026-07-25"), day("2027-01-01"));
    expect(keys(years)).toEqual(["2026", "2027"]);
    expect(years[0].end).toEqual(day("2026-12-31"));
  });

  it("nothing is billed when the anchor is in the future", () => {
    expect(periodsInWindow("month", day("2026-09-01"), day("2026-07-25"))).toEqual([]);
  });

  it("issue day follows the service's billing rule", () => {
    const [july] = periodsInWindow("month", day("2026-07-01"), day("2026-07-01"));
    expect(issueDayFor(july, "on_period_start", null)).toEqual(day("2026-07-01"));
    expect(issueDayFor(july, "on_period_start", 15)).toEqual(day("2026-07-15"));
    expect(issueDayFor(july, "on_period_end", null)).toEqual(day("2026-07-31"));

    // a custom day past the month's length clamps to the last day (February)
    const [feb] = periodsInWindow("month", day("2026-02-01"), day("2026-02-01"));
    expect(issueDayFor(feb, "on_period_start", 31)).toEqual(day("2026-02-28"));

    // quarterly/yearly custom day counts in the period's FIRST month
    const [q3] = periodsInWindow("quarter", day("2026-07-01"), day("2026-07-01"));
    expect(issueDayFor(q3, "on_period_start", 10)).toEqual(day("2026-07-10"));
    expect(issueDayFor(q3, "on_period_end", null)).toEqual(day("2026-09-30"));
  });
});

describe("invoice status", () => {
  const base = { amount: 10_000, paid: 0, dueDate: null, cancelledAt: null };
  const at = (iso: string) => new Date(iso);
  /** the business date the reader is on */
  const on = (isoDay: string) => businessDateMs(`${isoDay}T00:00:00Z`);

  it("cancelled and paid win over everything", () => {
    expect(deriveStatus({ ...base, cancelledAt: at("2026-07-01T00:00:00Z"), paid: 0 })).toBe("cancelled");
    expect(deriveStatus({ ...base, paid: 10_000, dueDate: at("2020-01-01T00:00:00Z") })).toBe("paid");
    // an overpayment still reads as paid, never negative
    expect(deriveStatus({ ...base, paid: 12_000 })).toBe("paid");
  });

  it("overdue only after the whole due day has passed", () => {
    const due = "2026-07-25T00:00:00Z";
    expect(deriveStatus({ ...base, dueDate: due }, on("2026-07-25"))).toBe("unpaid");
    expect(deriveStatus({ ...base, dueDate: due }, on("2026-07-26"))).toBe("overdue");
    // a part-paid invoice past its due day is overdue, not partial
    expect(deriveStatus({ ...base, paid: 4_000, dueDate: due }, on("2026-07-27"))).toBe("overdue");
    expect(deriveStatus({ ...base, paid: 4_000, dueDate: due }, on("2026-07-25"))).toBe("partial");
  });

  it("a job invoice due later today is not late yet (timestamp due dates)", () => {
    // job invoices carry a real timestamp (issue + N days), period invoices a midnight date —
    // both are compared as calendar days, so neither is late on its own due day
    const due = at("2026-07-25T14:30:00Z");
    expect(deriveStatus({ ...base, dueDate: due }, on("2026-07-25"))).toBe("unpaid");
    expect(deriveStatus({ ...base, dueDate: due }, on("2026-07-26"))).toBe("overdue");
  });
});

describe("business dates (the one overdue rule)", () => {
  const day = (isoDay: string) => businessDateMs(`${isoDay}T00:00:00Z`);

  it("an item due today is due today, not late", () => {
    expect(isPastBusinessDate("2026-07-26T00:00:00Z", day("2026-07-26"))).toBe(false);
    expect(isPastBusinessDate("2026-07-26T00:00:00Z", day("2026-07-27"))).toBe(true);
    expect(isPastBusinessDate("2026-07-26T00:00:00Z", day("2026-07-25"))).toBe(false);
    expect(isPastBusinessDate(null, day("2030-01-01"))).toBe(false); // no deadline is never late
  });

  it("tasks and invoices answer 'late' the same way", () => {
    const deadline = "2026-07-26T00:00:00Z";
    // due today: neither the board's red ring nor the invoice pill fires
    expect(isTaskOverdue({ done: false, deadline }, day("2026-07-26"))).toBe(false);
    expect(deriveStatus({ amount: 100, paid: 0, dueDate: deadline, cancelledAt: null }, day("2026-07-26"))).toBe("unpaid");
    // the day after: both do
    expect(isTaskOverdue({ done: false, deadline }, day("2026-07-27"))).toBe(true);
    expect(deriveStatus({ amount: 100, paid: 0, dueDate: deadline, cancelledAt: null }, day("2026-07-27"))).toBe("overdue");
  });

  it("a completed task is never overdue", () => {
    expect(isTaskOverdue({ done: true, deadline: "2020-01-01T00:00:00Z" }, day("2026-07-26"))).toBe(false);
  });

  it("collapses a stored instant to its calendar day, whatever the time of day", () => {
    const midnight = businessDateMs("2026-07-26T00:00:00Z");
    expect(businessDateMs("2026-07-26T14:30:00Z")).toBe(midnight);
    expect(businessDateMs("2026-07-26T23:59:59Z")).toBe(midnight);
  });

  it("the firm timezone decides 'today', not the process timezone", () => {
    // 01:00 in Kyiv (UTC+3) is still 22:00 UTC the previous day. The sweep and the status rule
    // read the firm's calendar, so work due on the 26th is late from Kyiv-midnight on the 27th.
    const kyivJustAfterMidnight = new Date("2026-07-26T22:00:00Z");
    expect(todayBusinessMs("Europe/Kyiv")).toBeTypeOf("number");
    expect(fromDate(kyivJustAfterMidnight, "Europe/Kyiv")).toEqual({ y: 2026, m: 7, d: 27 });
    expect(fromDate(kyivJustAfterMidnight, "UTC")).toEqual({ y: 2026, m: 7, d: 26 });
  });
});
