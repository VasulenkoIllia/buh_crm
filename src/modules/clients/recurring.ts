import type { Client } from "@shared/schema/client";
import type { Service } from "@shared/schema/catalog";

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
 * anyone bills, so both are returned and the row shows both rather than inventing one number.
 */
export const PERIOD_ORDER = ["month", "quarter", "year"] as const;

export type RecurringTotal = [period: string, amount: number];

export function recurringByPeriod(
  client: Pick<Client, "subscriptions">,
  serviceById: Map<string, Pick<Service, "type">>,
): RecurringTotal[] {
  const totals = new Map<string, number>();
  for (const sub of client.subscriptions) {
    // `period === null` already means one-time, but the service's type is the rule the rest of the
    // app derives from — checking both means neither alone can quietly let a job price through
    if (!sub.active || sub.period === null) continue;
    if (serviceById.get(sub.serviceId)?.type !== "subscription") continue;
    totals.set(sub.period, (totals.get(sub.period) ?? 0) + sub.amount);
  }
  return [...totals.entries()].sort(
    (a, b) =>
      PERIOD_ORDER.indexOf(a[0] as (typeof PERIOD_ORDER)[number]) -
      PERIOD_ORDER.indexOf(b[0] as (typeof PERIOD_ORDER)[number]),
  );
}
