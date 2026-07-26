import { config } from "../../core/config.js";
import {
  type Day,
  calendarDay,
  cmp,
  daysInMonth,
  fromDate,
  todayInTz,
  toUtc,
} from "../../core/dates.js";
import { prisma } from "../../core/db.js";
import { issueInvoice } from "./invoicing.js";
import * as repo from "./payments.repository.js";

/**
 * Scheduler job #2 (S7): subscription → ONE invoice per period.
 *
 * Runs daily and on startup (same idempotent sweep, like job #1): every run scans
 * [billing anchor .. today] and issues what's missing, keyed by (subscriptionId,
 * periodKey) — the DB unique constraint, so downtime heals itself and a restart
 * never double-bills.
 *
 * BILLING ANCHOR (user decision 2026-07-25): a subscription is never back-billed.
 * The first invoice is the one for the period the subscription STARTED in;
 * `Subscription.billingStartAt` moves to "now" on reactivation, so a long-paused
 * subscription doesn't replay a year of invoices when it's switched back on.
 *
 * A CANCELLED period invoice is not re-issued — the (subscription, period) row still
 * exists, which is what "void, don't delete" means. Re-issue it manually if needed.
 */

interface Period {
  key: string;
  start: Day;
  end: Day;
}

const lastDayOf = (y: number, m: number): Day => ({ y, m, d: daysInMonth(y, m) });

/** Billing periods (month/quarter/year) that overlap [from .. to], `from`'s period first. */
export function periodsInWindow(period: "month" | "quarter" | "year", from: Day, to: Day): Period[] {
  const out: Period[] = [];
  if (cmp(from, to) > 0) return out;

  if (period === "month") {
    for (let y = from.y, m = from.m; y < to.y || (y === to.y && m <= to.m); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
      out.push({
        key: `${y}-${String(m).padStart(2, "0")}`,
        start: { y, m, d: 1 },
        end: lastDayOf(y, m),
      });
    }
    return out;
  }

  if (period === "quarter") {
    const first = Math.floor((from.m - 1) / 3) + 1;
    const last = Math.floor((to.m - 1) / 3) + 1;
    for (let y = from.y; y <= to.y; y++) {
      const qFrom = y === from.y ? first : 1;
      const qTo = y === to.y ? last : 4;
      for (let q = qFrom; q <= qTo; q++) {
        const startMonth = (q - 1) * 3 + 1;
        out.push({
          key: `${y}-Q${q}`,
          start: { y, m: startMonth, d: 1 },
          end: lastDayOf(y, startMonth + 2),
        });
      }
    }
    return out;
  }

  for (let y = from.y; y <= to.y; y++) {
    out.push({ key: `${y}`, start: { y, m: 1, d: 1 }, end: { y, m: 12, d: 31 } });
  }
  return out;
}

/**
 * The day inside a period an invoice is issued on (S3 billing rule):
 * `on_period_end` → last day; `on_period_start` → first day, or day N of the
 * period's first month when the service sets a custom day.
 */
export function issueDayFor(period: Period, trigger: string, invoiceDay: number | null): Day {
  if (trigger === "on_period_end") return period.end;
  return invoiceDay == null ? period.start : calendarDay(period.start.y, period.start.m, invoiceDay);
}

const subscriptionQuery = {
  where: {
    active: true,
    service: { type: "subscription" as const },
    client: { archivedAt: null },
  },
  select: {
    id: true,
    clientId: true,
    companyId: true,
    serviceId: true,
    amount: true,
    period: true,
    invoiceTrigger: true,
    invoiceDay: true,
    dueDays: true,
    billingStartAt: true,
    createdAt: true,
    service: { select: { invoiceTrigger: true, invoiceDay: true, dueDays: true } },
  },
};

type BillableSub = Awaited<ReturnType<typeof prisma.subscription.findMany<typeof subscriptionQuery>>>[number];

/** Periods of one subscription that are due today and not invoiced yet. */
function dueInvoices(sub: BillableSub, today: Day, issued: Set<string>, tz: string) {
  // per-client billing timing wins over the service preset (S3 decision)
  const trigger = sub.invoiceTrigger ?? sub.service.invoiceTrigger;
  const invoiceDay = sub.invoiceDay ?? sub.service.invoiceDay;
  const dueDays = sub.dueDays ?? sub.service.dueDays;
  const anchor = fromDate(sub.billingStartAt ?? sub.createdAt, tz);

  return periodsInWindow(sub.period, anchor, today).flatMap((period) => {
    if (issued.has(`${sub.id}|${period.key}`)) return [];
    const issueDay = issueDayFor(period, trigger, invoiceDay);
    if (cmp(issueDay, today) > 0) return []; // this period's invoice isn't due yet
    // never date an invoice before the subscription started billing: for the anchor period
    // (a subscription added mid-period) it's issued on the start day, not backdated to the 1st —
    // otherwise its overdue terms would already have elapsed the moment it was created
    const issuedAt = toUtc(cmp(issueDay, anchor) < 0 ? anchor : issueDay);
    return [
      {
        clientId: sub.clientId,
        companyId: sub.companyId,
        serviceId: sub.serviceId,
        subscriptionId: sub.id,
        periodKey: period.key,
        amount: sub.amount,
        issuedAt,
        dueDate: dueDays == null ? null : new Date(issuedAt.getTime() + dueDays * 86_400_000),
      },
    ];
  });
}

/**
 * Issue everything due for these subscriptions. Failures are isolated PER SUBSCRIPTION —
 * one client's bad row (or a transient DB error) must not stop the firm's billing run; the
 * sweep is idempotent, so whatever failed is retried on the next run.
 */
async function issueDue(subs: BillableSub[]) {
  if (subs.length === 0) return { created: 0, failed: 0 };
  const today = todayInTz(config.TZ);
  const existing = await repo.listPeriodKeys(subs.map((s) => s.id));
  const issued = new Set(existing.map((i) => `${i.subscriptionId}|${i.periodKey}`));

  let created = 0;
  let failed = 0;
  for (const sub of subs) {
    try {
      for (const invoice of dueInvoices(sub, today, issued, config.TZ)) {
        try {
          await issueInvoice(invoice);
          created++;
        } catch (err) {
          // a concurrent sweep issued the same (subscription, period) first → skip
          if ((err as { code?: string }).code !== "P2002") throw err;
        }
      }
    } catch {
      failed++;
    }
  }
  return { created, failed };
}

/** Full sweep — the daily run AND the startup catch-up. */
export async function generatePeriodInvoices() {
  return issueDue(await prisma.subscription.findMany(subscriptionQuery));
}

/** Instant feedback when a subscription is added or reactivated on the client card. */
export async function generateForSubscriptionInvoices(subscriptionId: string) {
  const sub = await prisma.subscription.findFirst({
    ...subscriptionQuery,
    where: { ...subscriptionQuery.where, id: subscriptionId },
  });
  return issueDue(sub ? [sub] : []); // stopped / one-time / archived client → nothing to bill
}
