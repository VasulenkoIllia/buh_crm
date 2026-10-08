import { describe, expect, it } from "vitest";
import { businessDateMs, isPastBusinessDate, isTaskOverdue } from "@shared/dates.js";
import { deriveStatus } from "@shared/schema/payment.js";
import { fromDate, todayBusinessMs } from "../../core/dates.js";
import { periodRange } from "@shared/billing-periods.js";
import { dueInvoices, issueDayFor, periodsInWindow } from "./payments.generation.js";
import type { BillableSubscription } from "./payments.repository.js";

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
    expect(deriveStatus({ ...base, cancelledAt: at("2026-07-01T00:00:00Z"), paid: 0 })).toBe(
      "cancelled",
    );
    expect(deriveStatus({ ...base, paid: 10_000, dueDate: at("2020-01-01T00:00:00Z") })).toBe(
      "paid",
    );
    // an overpayment still reads as paid, never negative
    expect(deriveStatus({ ...base, paid: 12_000 })).toBe("paid");
  });

  it("overdue only after the whole due day has passed", () => {
    const due = "2026-07-25T00:00:00Z";
    expect(deriveStatus({ ...base, dueDate: due }, on("2026-07-25"))).toBe("unpaid");
    expect(deriveStatus({ ...base, dueDate: due }, on("2026-07-26"))).toBe("overdue");
    // a part-paid invoice past its due day is overdue, not partial
    expect(deriveStatus({ ...base, paid: 4_000, dueDate: due }, on("2026-07-27"))).toBe(
      "overdue",
    );
    expect(deriveStatus({ ...base, paid: 4_000, dueDate: due }, on("2026-07-25"))).toBe(
      "partial",
    );
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
    expect(
      deriveStatus(
        { amount: 100, paid: 0, dueDate: deadline, cancelledAt: null },
        day("2026-07-26"),
      ),
    ).toBe("unpaid");
    // the day after: both do
    expect(isTaskOverdue({ done: false, deadline }, day("2026-07-27"))).toBe(true);
    expect(
      deriveStatus(
        { amount: 100, paid: 0, dueDate: deadline, cancelledAt: null },
        day("2026-07-27"),
      ),
    ).toBe("overdue");
  });

  it("a completed task is never overdue", () => {
    expect(
      isTaskOverdue({ done: true, deadline: "2020-01-01T00:00:00Z" }, day("2026-07-26")),
    ).toBe(false);
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

/**
 * A subscription that changes its period must not bill the same days twice (found 2026-10-07).
 *
 * The sweep's guard was the period KEY, and a monthly `2026-10` and a quarterly `2026-Q4` are
 * different keys for overlapping days: moved to quarterly on 7 October, a client already invoiced
 * for October was invoiced for the whole of Q4 as well.
 */
describe("a subscription that changes its period", () => {
  const sub = (period: "month" | "quarter" | "year", since: string, rhythmSince?: string) =>
    ({
      id: "sub-1",
      clientId: "client-1",
      companyId: null,
      serviceId: "service-1",
      amount: 90_000,
      period,
      invoiceTrigger: "on_period_start",
      invoiceDay: null,
      dueDays: null,
      createdAt: new Date(`${since}T00:00:00Z`),
      periodSince: rhythmSince ? new Date(`${rhythmSince}T00:00:00Z`) : null,
      periods: [{ startsOn: new Date(`${since}T00:00:00Z`), endsBefore: null }],
      service: {
        name: "Bookkeeping",
        invoiceTrigger: "on_period_start",
        invoiceDay: null,
        dueDays: null,
      },
    }) as unknown as BillableSubscription;
  // a key ending in "!" stands for a CANCELLED invoice of that period
  const billed = (...periodKeys: string[]) => {
    const live = periodKeys.filter((k) => !k.endsWith("!"));
    const cancelled = periodKeys.filter((k) => k.endsWith("!")).map((k) => k.slice(0, -1));
    return {
      issued: new Set([...live, ...cancelled].map((k) => `sub-1|${k}`)),
      ranges: {
        live: live.map((k) => periodRange(k)!),
        cancelled: cancelled.map((k) => periodRange(k)!),
      },
    };
  };
  const outcomes = (due: ReturnType<typeof dueInvoices>) =>
    due.map((d) => `${d.key}:${d.outcome}`);

  it("months to quarters: the quarter October already paid into goes to a person", () => {
    const { issued, ranges } = billed("2026-10");
    const due = dueInvoices(sub("quarter", "2026-10-01"), day("2026-10-07"), issued, ranges);
    expect(outcomes(due)).toEqual(["2026-Q4:remind"]);
  });

  it("quarters to months: months the quarter already covers are not billed again", () => {
    const { issued, ranges } = billed("2026-Q4");
    const due = dueInvoices(sub("month", "2026-10-01"), day("2026-11-05"), issued, ranges);
    expect(due).toEqual([]);
  });

  it("the period after the overlap bills as it always did", () => {
    const { issued, ranges } = billed("2026-Q4");
    const due = dueInvoices(sub("month", "2026-10-01"), day("2027-01-02"), issued, ranges);
    expect(outcomes(due)).toEqual(["2027-01:invoice"]);
    expect(due[0].row?.amount).toBe(90_000);
  });

  it("an unchanged rhythm is untouched: last month billed, this month invoiced", () => {
    const { issued, ranges } = billed("2026-09");
    const due = dueInvoices(sub("month", "2026-09-01"), day("2026-10-07"), issued, ranges);
    expect(outcomes(due)).toEqual(["2026-10:invoice"]);
  });

  it("a cancelled invoice of another shape is never skipped over in silence", () => {
    // Saida Akhbayeva's Payroll in production: 2026-10 and 2026-Q4 both issued. Cancelling the
    // quarter as the mistake must not leave November unbilled without anybody being told.
    const { issued, ranges } = billed("2026-09", "2026-10", "2026-Q4!");
    const due = dueInvoices(sub("month", "2026-09-01"), day("2026-11-02"), issued, ranges);
    expect(outcomes(due)).toEqual(["2026-11:remind"]);
  });

  it("a new rhythm does not reach back: September, begun before the change, goes to a person", () => {
    // Saida, as it happened: quarterly until 6 October, then monthly; the quarter's invoice covers
    // October, and September, never billed by the quarterly rhythm, was billed the next night
    const { issued, ranges } = billed("2026-Q4");
    const due = dueInvoices(
      sub("month", "2026-09-01", "2026-10-06"),
      day("2026-10-07"),
      issued,
      ranges,
    );
    expect(outcomes(due)).toEqual(["2026-09:remind"]);
  });

  it("after the change, a cancelled invoice of the old rhythm holds nothing back", () => {
    // the quarter cancelled as the mistake: November is the new rhythm's, and bills on its own
    const { issued, ranges } = billed("2026-09", "2026-10", "2026-Q4!");
    const due = dueInvoices(
      sub("month", "2026-09-01", "2026-10-06"),
      day("2026-11-02"),
      issued,
      ranges,
    );
    expect(outcomes(due)).toEqual(["2026-11:invoice"]);
  });

  it("a period that starts on the day of the change is the new rhythm's", () => {
    const { issued, ranges } = billed("2026-09", "2026-10");
    const since = sub("month", "2026-09-01", "2026-11-01");
    expect(outcomes(dueInvoices(since, day("2026-11-02"), issued, ranges))).toEqual([
      "2026-11:invoice",
    ]);
  });

  it("with the month cancelled instead, the live quarter covers it", () => {
    const { issued, ranges } = billed("2026-09", "2026-10!", "2026-Q4");
    const due = dueInvoices(sub("month", "2026-09-01"), day("2026-11-02"), issued, ranges);
    expect(due).toEqual([]);
  });
});

/** Every week and twice a month (owner, 2026-10-07). */
describe("weekly and twice-a-month billing", () => {
  const sub = (
    period: "week" | "half_month",
    since: string,
    over: { amount?: number; trigger?: string; day?: number | null; presetDay?: number } = {},
  ) =>
    ({
      id: "sub-2",
      clientId: "client-1",
      companyId: null,
      serviceId: "service-1",
      amount: over.amount ?? 20_000,
      period,
      invoiceTrigger: over.trigger ?? "on_period_start",
      invoiceDay: over.day ?? null,
      dueDays: null,
      createdAt: new Date(`${since}T00:00:00Z`),
      periods: [{ startsOn: new Date(`${since}T00:00:00Z`), endsBefore: null }],
      service: {
        name: "Payroll",
        invoiceTrigger: "on_period_start",
        invoiceDay: over.presetDay ?? null,
        dueDays: null,
      },
    }) as unknown as BillableSubscription;
  const issued = (due: ReturnType<typeof dueInvoices>) =>
    due.map((d) => [
      d.key,
      d.outcome,
      d.row ? fromDate(d.row.issuedAt, "UTC") : null,
      d.row?.amount,
    ]);

  it("weeks run Monday to Sunday, from the week the window opens in", () => {
    const weeks = periodsInWindow("week", day("2026-10-07"), day("2026-10-19"));
    expect(keys(weeks)).toEqual(["2026-W41", "2026-W42", "2026-W43"]);
    expect(weeks[0].start).toEqual(day("2026-10-05"));
    expect(weeks[0].end).toEqual(day("2026-10-11"));
    // across the turn of a year: 2026 has a week 53, and week 1 of 2027 starts on 4 January
    expect(keys(periodsInWindow("week", day("2026-12-24"), day("2027-01-05")))).toEqual([
      "2026-W52",
      "2026-W53",
      "2027-W01",
    ]);
  });

  it("halves run 1–15 and 16–end, only where they meet the window", () => {
    const halves = periodsInWindow("half_month", day("2026-10-20"), day("2026-11-10"));
    expect(keys(halves)).toEqual(["2026-10-H2", "2026-11-H1"]);
    expect(halves[0].start).toEqual(day("2026-10-16"));
    expect(halves[0].end).toEqual(day("2026-10-31"));
    const [, february] = periodsInWindow("half_month", day("2027-02-01"), day("2027-02-28"));
    expect(february.end).toEqual(day("2027-02-28"));
  });

  it("a week bills on Monday, on Sunday, or on the day of the week chosen", () => {
    const [week] = periodsInWindow("week", day("2026-10-07"), day("2026-10-07"));
    expect(issueDayFor(week, "on_period_start", null, "week")).toEqual(day("2026-10-05"));
    expect(issueDayFor(week, "on_period_end", null, "week")).toEqual(day("2026-10-11"));
    expect(issueDayFor(week, "on_period_start", 5, "week")).toEqual(day("2026-10-09"));
  });

  it("twice a month bills on the 15th and the last day, whatever the trigger says", () => {
    const [h1, h2] = periodsInWindow("half_month", day("2026-10-01"), day("2026-10-31"));
    for (const trigger of ["on_period_start", "on_period_end"]) {
      expect(issueDayFor(h1, trigger, null, "half_month")).toEqual(day("2026-10-15"));
      expect(issueDayFor(h2, trigger, null, "half_month")).toEqual(day("2026-10-31"));
    }
  });

  it("bills half of the monthly price on each, the odd cent on the second", () => {
    const due = dueInvoices(
      sub("half_month", "2026-10-01", { amount: 90_001 }),
      day("2026-10-31"),
      new Set(),
    );
    expect(issued(due)).toEqual([
      ["2026-10-H1", "invoice", day("2026-10-15"), 45_000],
      ["2026-10-H2", "invoice", day("2026-10-31"), 45_001],
    ]);
    // on the 20th only the first half is due
    const early = dueInvoices(sub("half_month", "2026-10-01"), day("2026-10-20"), new Set());
    expect(early.map((d) => d.key)).toEqual(["2026-10-H1"]);
  });

  it("a week started mid-week behaves as a month started mid-month", () => {
    // billed at the start: the Monday was never served, so that week is not this subscription's
    const ahead = dueInvoices(sub("week", "2026-10-07"), day("2026-10-13"), new Set());
    expect(issued(ahead)).toEqual([["2026-W42", "invoice", day("2026-10-12"), 20_000]]);
    // billed at the end: served Wednesday to Sunday only, so a person decides that one
    const after = dueInvoices(
      sub("week", "2026-10-07", { trigger: "on_period_end" }),
      day("2026-10-18"),
      new Set(),
    );
    expect(issued(after)).toEqual([
      ["2026-W41", "remind", null, undefined],
      ["2026-W42", "invoice", day("2026-10-18"), 20_000],
    ]);
  });

  it("a week ignores the service's preset day, which is a day of the month", () => {
    // a preset of 20 would be no day of any week: the week bills on its Monday instead
    const due = dueInvoices(
      sub("week", "2026-10-05", { presetDay: 20 }),
      day("2026-10-06"),
      new Set(),
    );
    expect(issued(due)).toEqual([["2026-W41", "invoice", day("2026-10-05"), 20_000]]);
    // its own day, Friday, counts
    const friday = dueInvoices(
      sub("week", "2026-10-05", { day: 5 }),
      day("2026-10-09"),
      new Set(),
    );
    expect(issued(friday)).toEqual([["2026-W41", "invoice", day("2026-10-09"), 20_000]]);
  });

  it("a month already billed covers its halves; a month to twice a month bills nothing twice", () => {
    const due = dueInvoices(
      sub("half_month", "2026-10-01"),
      day("2026-11-16"),
      new Set(["sub-2|2026-10"]),
      { live: [periodRange("2026-10")!], cancelled: [] },
    );
    expect(due.map((d) => d.key)).toEqual(["2026-11-H1"]);
  });
});
