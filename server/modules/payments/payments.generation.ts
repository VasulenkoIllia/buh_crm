import { config } from "../../core/config.js";
import {
  type Day,
  addDays,
  calendarDay,
  cmp,
  daysInMonth,
  todayInTz,
  toUtc,
} from "../../core/dates.js";
import { coverage, firstDayInForce } from "../../core/coverage.js";
import { raiseSystemTask } from "../../core/system-tasks.js";
import { issueInvoice } from "./invoicing.js";
import * as repo from "./payments.repository.js";
import type { BillableSubscription } from "./payments.repository.js";

/**
 * Scheduler job #2 (S7): subscription → ONE invoice per period.
 *
 * Runs daily and on startup (same idempotent sweep, like job #1): every run scans
 * [billing anchor .. today] and issues what's missing, keyed by (subscriptionId,
 * periodKey) — the DB unique constraint, so downtime heals itself and a restart
 * never double-bills.
 *
 * SERVED PERIODS (user decision 2026-07-29): the window starts at the first day the subscription
 * was ever in force, and a period is billed only when it was served CONTINUOUSLY from its first
 * day through its trigger day. A period served only in part raises a reminder for a person to
 * invoice by hand instead — the amount for half a period is an agreement, not arithmetic. Nothing
 * is ever back-billed for a pause, and the 45-day horizon bounds what a mistyped start date can do.
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

/**
 * How far back the sweep will still issue automatically. Beyond it a period is only ever
 * REPORTED (a reminder task), never billed on its own.
 *
 * The window now starts at the subscription's earliest served day, so one mistyped backdated
 * start would otherwise have the sweep quietly issue a year of invoices. This bounds the blast
 * radius of any date entry while leaving catch-up after downtime working.
 */
const AUTO_ISSUE_HORIZON_DAYS = 45;

interface DuePeriod {
  key: string;
  /** billed automatically, or only reported for a human to invoice by hand */
  outcome: "invoice" | "remind";
  row?: {
    clientId: string;
    companyId: string | null;
    serviceId: string;
    subscriptionId: string;
    periodKey: string;
    amount: number;
    issuedAt: Date;
    dueDays: number | null;
  };
}

/**
 * What this subscription owes for, period by period.
 *
 * ONE rule for prepay and postpay: a period is invoiced automatically only if the subscription was
 * in force **continuously from the period's first day through its trigger day**. For
 * `on_period_start` on the 1st that is "in force on the 1st"; for a custom day 15, "in force
 * 1–15"; for `on_period_end`, "in force all period". A period served only in PART is never
 * invoiced automatically — the amount for half a month is a negotiation, not arithmetic — it is
 * reported instead so a person issues it by hand (decision 2026-07-29).
 */
function dueInvoices(sub: BillableSubscription, today: Day, issued: Set<string>): DuePeriod[] {
  // per-client billing timing wins over the service preset (S3 decision)
  const trigger = sub.invoiceTrigger ?? sub.service.invoiceTrigger;
  const invoiceDay = sub.invoiceDay ?? sub.service.invoiceDay;
  const dueDays = sub.dueDays ?? sub.service.dueDays;
  const from = firstDayInForce(sub.periods);
  if (!from) return [];
  // Only a SUBSCRIPTION service reaches here — `billableSubscription()` filters on the type — so a
  // null period would mean that filter had changed underneath this function rather than that a
  // one-time job needs billing. Returning nothing is the safe answer either way: a one-time job is
  // invoiced when the job is done, never by the period sweep.
  if (!sub.period) return [];
  const horizon = addDays(today, -AUTO_ISSUE_HORIZON_DAYS);

  return periodsInWindow(sub.period, from, today).flatMap((period): DuePeriod[] => {
    if (issued.has(`${sub.id}|${period.key}`)) return [];
    const issueDay = issueDayFor(period, trigger, invoiceDay);
    if (cmp(issueDay, today) > 0) return []; // this period's invoice isn't due yet

    const served = coverage(sub.periods, period.start, issueDay);
    if (served === "none") return []; // the period never belonged to this subscription
    // partially served, or older than the horizon → a person decides the amount / the date
    if (served === "partial" || cmp(issueDay, horizon) < 0) {
      return [{ key: period.key, outcome: "remind" }];
    }
    return [
      {
        key: period.key,
        outcome: "invoice",
        row: {
          clientId: sub.clientId,
          companyId: sub.companyId,
          serviceId: sub.serviceId,
          subscriptionId: sub.id,
          periodKey: period.key,
          amount: sub.amount,
          issuedAt: toUtc(issueDay),
          dueDays, // `invoiceRow` derives dueDate = issuedAt + dueDays — one rule, one place
        },
      },
    ];
  });
}

/**
 * Issue everything due for these subscriptions. Failures are isolated PER SUBSCRIPTION —
 * one client's bad row (or a transient DB error) must not stop the firm's billing run; the
 * sweep is idempotent, so whatever failed is retried on the next run.
 */
async function issueDue(subs: BillableSubscription[]) {
  if (subs.length === 0) return { created: 0, failed: 0 };
  const today = todayInTz(config.TZ);
  const existing = await repo.listPeriodKeys(subs.map((s) => s.id));
  const issued = new Set(existing.map((i) => `${i.subscriptionId}|${i.periodKey}`));

  let created = 0;
  let reminded = 0;
  let failed = 0;
  for (const sub of subs) {
    try {
      for (const due of dueInvoices(sub, today, issued)) {
        try {
          if (due.outcome === "invoice") {
            await issueInvoice(due.row!);
            created++;
          } else {
            // partially served, or older than the auto-issue horizon: the system will not guess
            // the amount, so it asks a person to. One task per (subscription, period).
            const raised = await raiseSystemTask(
              "partial_period_invoice",
              {
                clientId: sub.clientId,
                companyId: sub.companyId,
                serviceId: sub.serviceId,
                subscriptionId: sub.id,
              },
              due.key,
              { titleSuffix: due.key },
            );
            if (raised) reminded++;
          }
        } catch (err) {
          // a concurrent sweep issued the same (subscription, period) first → skip
          if ((err as { code?: string }).code !== "P2002") throw err;
        }
      }
    } catch {
      failed++;
    }
  }
  return { created, reminded, failed };
}

/** Full sweep — the daily run AND the startup catch-up. */
export async function generatePeriodInvoices() {
  return issueDue(await repo.listBillableSubscriptions());
}

/** Instant feedback when a subscription is added or reactivated on the client card. */
export async function generateForSubscriptionInvoices(subscriptionId: string) {
  const sub = await repo.findBillableSubscription(subscriptionId);
  return issueDue(sub ? [sub] : []); // stopped / one-time / archived client → nothing to bill
}
