import type { Client } from "@shared/schema/client";
import { billsPerJob, type Service } from "@shared/schema/catalog";
import type { BillingPeriod } from "@shared/schema/enums";

/**
 * What the firm bills a client EVERY PERIOD, kept apart by period.
 *
 * Its own module because it is money, and because it was wrong: the Regular row used to sum every
 * active subscription and label the total with `period` — so a client on $600 a month with three
 * one-time jobs attached read as "$1,800 monthly", a figure the firm never invoices (user,
 * 2026-08-26). Two independent mistakes lived in that one cell, and both are ruled out here.
 *
 * **Only subscription services.** A one-time service is a container for manual jobs and its
 * `amount` is a price per JOB. It is not lost: the Category chips show it and Debt settles it.
 *
 * **Periods are never added together.** $600 a month and $300 a quarter have no common total that
 * anyone bills, so both are returned and the row shows both rather than inventing one number. A
 * week is no exception: four or five of them fall in a month, so a weekly price is its own total.
 *
 * **Twice a month IS monthly.** Its price is the monthly rate, billed in halves (2026-10-07), so it
 * adds into the month's total; a separate "twice a month" figure would be the same money twice.
 */
const PERIOD_ORDER: BillingPeriod[] = ["week", "month", "quarter", "year"];

/** The total a subscription's price adds into: its own period, except the halves of a month. */
const totalOf = (period: BillingPeriod): BillingPeriod =>
  period === "half_month" ? "month" : period;

/** How a period is written out. One map — the clients list had a second, identical copy. */
export const PERIOD_LABEL: Record<BillingPeriod, string> = {
  week: "weekly",
  half_month: "monthly", // the row adds "15th and last day", which says the rest
  month: "monthly",
  quarter: "quarterly",
  year: "yearly",
};

/** …and the short form, for the cell that has to fit several of them beside figures. */
export const PERIOD_SHORT: Record<BillingPeriod, string> = {
  week: "wk",
  half_month: "mo",
  month: "mo",
  quarter: "qtr",
  year: "yr",
};

export type RecurringTotal = [period: BillingPeriod, amount: number];

export function recurringByPeriod(
  client: Pick<Client, "subscriptions">,
  serviceById: Map<string, Pick<Service, "type">>,
): RecurringTotal[] {
  const totals = new Map<BillingPeriod, number>();
  for (const sub of client.subscriptions) {
    // `period === null` already means one-time, but the service's type is the rule the rest of the
    // app derives from — checking both means neither alone can quietly let a job price through
    if (!sub.active || sub.period === null) continue;
    const service = serviceById.get(sub.serviceId);
    if (!service || billsPerJob(service)) continue;
    const period = totalOf(sub.period);
    totals.set(period, (totals.get(period) ?? 0) + sub.amount);
  }
  return [...totals.entries()].sort(
    (a, b) => PERIOD_ORDER.indexOf(a[0]) - PERIOD_ORDER.indexOf(b[0]),
  );
}
