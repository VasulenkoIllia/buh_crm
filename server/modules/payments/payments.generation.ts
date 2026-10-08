import { config } from "../../core/config.js";
import {
  type Day,
  addDays,
  calendarDay,
  cmp,
  daysInMonth,
  fromDate,
  todayInTz,
  toUtc,
} from "../../core/dates.js";
import {
  type PeriodRange,
  invoiceAmount,
  periodLabel,
  periodRange,
  weekKey,
} from "@shared/billing-periods.js";
import type { BillingPeriod } from "@shared/schema/enums.js";
import { type Coverage, coverage, firstDayInForce } from "../../core/coverage.js";
import { raiseSystemTask } from "../../core/system-tasks.js";
import { issueInvoice } from "./invoicing.js";
import { record } from "../../core/activity.js";
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

/** Billing periods that overlap [from .. to], `from`'s period first. */
export function periodsInWindow(period: BillingPeriod, from: Day, to: Day): Period[] {
  const out: Period[] = [];
  if (cmp(from, to) > 0) return out;

  // Monday to Sunday, the ISO weeks the task rhythms already count by (owner, 2026-10-07)
  if (period === "week") {
    const dow = toUtc(from).getUTCDay() || 7; // Mon=1..Sun=7
    for (
      let monday = addDays(from, 1 - dow);
      cmp(monday, to) <= 0;
      monday = addDays(monday, 7)
    ) {
      out.push({ key: weekKey(monday), start: monday, end: addDays(monday, 6) });
    }
    return out;
  }

  // the 1st to the 15th and the 16th to the month's end, each kept only where it meets the window
  if (period === "half_month") {
    for (
      let y = from.y, m = from.m;
      y < to.y || (y === to.y && m <= to.m);
      m === 12 ? ((y += 1), (m = 1)) : (m += 1)
    ) {
      const month = `${y}-${String(m).padStart(2, "0")}`;
      const halves: Period[] = [
        { key: `${month}-H1`, start: { y, m, d: 1 }, end: { y, m, d: 15 } },
        { key: `${month}-H2`, start: { y, m, d: 16 }, end: lastDayOf(y, m) },
      ];
      out.push(...halves.filter((h) => cmp(h.end, from) >= 0 && cmp(h.start, to) <= 0));
    }
    return out;
  }

  if (period === "month") {
    for (
      let y = from.y, m = from.m;
      y < to.y || (y === to.y && m <= to.m);
      m === 12 ? ((y += 1), (m = 1)) : (m += 1)
    ) {
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

  if (period === "year") {
    for (let y = from.y; y <= to.y; y++) {
      out.push({ key: `${y}`, start: { y, m: 1, d: 1 }, end: { y, m: 12, d: 31 } });
    }
    return out;
  }

  // Not a fall-through to "year", which is what an unknown rhythm used to become: a weekly price
  // billed as a year. A throw fails this one subscription, logged, and the run carries on.
  throw new Error(`Unknown billing period: ${period satisfies never}`);
}

/**
 * The day inside a period an invoice is issued on (S3 billing rule):
 * `on_period_end` → last day; `on_period_start` → first day, or the custom day: day N of the
 * period's first month, or for a week day N of the week (Monday = 1).
 *
 * Twice a month has no choice: each half bills on its last day, the 15th and the month's end
 * (owner, 2026-10-07).
 */
export function issueDayFor(
  period: Period,
  trigger: string,
  invoiceDay: number | null,
  rhythm: BillingPeriod = "month",
): Day {
  if (rhythm === "half_month") return period.end;
  if (trigger === "on_period_end") return period.end;
  if (invoiceDay == null) return period.start;
  if (rhythm === "week") return addDays(period.start, Math.min(Math.max(invoiceDay, 1), 7) - 1);
  return calendarDay(period.start.y, period.start.m, invoiceDay);
}

/**
 * How much of a period this subscription's invoices ALREADY cover, under any key.
 *
 * The key guards a period against itself and nothing else. A subscription that changes its period
 * writes keys of a new shape over days the old shape billed: monthly to quarterly on 7 October put
 * `2026-Q4` beside `2026-10`, and the sweep billed the quarter whole (found 2026-10-07). Read as
 * days, the two overlap. `"full"` means every day is billed already and nothing happens;
 * `"partial"` means some are, which is a person's decision exactly like a partly served period.
 */
export function alreadyBilled(period: PeriodRange, billed: readonly PeriodRange[]): Coverage {
  const overlapping = billed
    .filter((r) => cmp(r.start, period.end) <= 0 && cmp(r.end, period.start) >= 0)
    .sort((a, b) => cmp(a.start, b.start));
  if (overlapping.length === 0) return "none";
  // walk the period from its first day; any day no invoice reaches makes it partial
  let next: Day = period.start;
  for (const r of overlapping) {
    if (cmp(r.start, next) > 0) return "partial";
    if (cmp(r.end, next) >= 0) next = addDays(r.end, 1);
    if (cmp(next, period.end) > 0) return "full";
  }
  return "partial";
}

/**
 * A subscription's period invoices as DAYS, the live apart from the cancelled.
 *
 * Apart because they answer different questions. A live invoice's days are billed: covered whole,
 * the period is skipped. A cancelled one's are not billed, and not free either: Saida Akhbayeva's
 * Payroll held `2026-10` and `2026-Q4` side by side in production (2026-10-07), and had the quarter
 * been cancelled as the mistake, counting it as billed would have skipped November and December
 * without a word. So a period touching a cancelled invoice of another shape goes to a person.
 */
export interface BilledDays {
  live: PeriodRange[];
  cancelled: PeriodRange[];
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
 *
 * `billed` is what this subscription's invoices already cover, read off their keys: a period whose
 * days a live invoice of another rhythm billed is skipped when they all were, and reported when
 * only some were (`alreadyBilled`).
 *
 * **A rhythm applies from the day it was chosen** (`Subscription.periodSince`, 2026-10-07). A period
 * that began before it, and that live invoices do not cover, is reported rather than billed: the old
 * rhythm may never have billed it on purpose, and a new one reaching back 45 days to bill it is how
 * Saida Akhbayeva was invoiced for September on 7 October. A period of the new rhythm is not held
 * back by a CANCELLED invoice of the old one, which billed nothing. With no recorded change, a
 * cancelled invoice of another shape is reported, since nothing says which rhythm it belonged to.
 */
export function dueInvoices(
  sub: BillableSubscription,
  today: Day,
  issued: Set<string>,
  billed: BilledDays = { live: [], cancelled: [] },
): DuePeriod[] {
  // per-client billing timing wins over the service preset (S3 decision)
  const trigger = sub.invoiceTrigger ?? sub.service.invoiceTrigger;
  // A service's preset day is a day of the MONTH. A week counts its days 1–7 and twice a month
  // takes none, so neither inherits one: a preset of 20 would be no day of any week.
  const invoiceDay =
    sub.period === "week" || sub.period === "half_month"
      ? sub.invoiceDay
      : (sub.invoiceDay ?? sub.service.invoiceDay);
  const dueDays = sub.dueDays ?? sub.service.dueDays;
  const from = firstDayInForce(sub.periods);
  if (!from) return [];
  // Only a SUBSCRIPTION service reaches here — `billableSubscription()` filters on the type — so a
  // null period would mean that filter had changed underneath this function rather than that a
  // one-time job needs billing. Returning nothing is the safe answer either way: a one-time job is
  // invoiced when the job is done, never by the period sweep.
  if (!sub.period) return [];
  const rhythm = sub.period;
  // a calendar day stored at UTC midnight, so it is read in UTC
  const since = sub.periodSince ? fromDate(sub.periodSince, "UTC") : null;
  const horizon = addDays(today, -AUTO_ISSUE_HORIZON_DAYS);

  return periodsInWindow(rhythm, from, today).flatMap((period): DuePeriod[] => {
    if (issued.has(`${sub.id}|${period.key}`)) return [];
    const issueDay = issueDayFor(period, trigger, invoiceDay, rhythm);
    if (cmp(issueDay, today) > 0) return []; // this period's invoice isn't due yet

    const served = coverage(sub.periods, period.start, issueDay);
    if (served === "none") return []; // the period never belonged to this subscription
    // billed already under another rhythm: all of it → nothing to do, some of it → a person
    const twice = alreadyBilled(period, billed.live);
    if (twice === "full") return [];
    const beforeRhythm = since !== null && cmp(period.start, since) < 0;
    const voided = since === null && alreadyBilled(period, billed.cancelled) !== "none";
    // partially served, partly billed, begun under an earlier rhythm, touching a voided invoice of
    // unknown rhythm, or older than the horizon → a person decides
    if (
      served === "partial" ||
      twice === "partial" ||
      beforeRhythm ||
      voided ||
      cmp(issueDay, horizon) < 0
    ) {
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
          // the price, or half the monthly one twice a month (`invoiceAmount`)
          amount: invoiceAmount(rhythm, sub.amount, period.key),
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
  // the same invoices as DAYS, per subscription, the cancelled kept apart (`BilledDays`)
  const billed = new Map<string, BilledDays>();
  for (const i of existing) {
    const range = i.periodKey ? periodRange(i.periodKey) : null;
    if (!i.subscriptionId || !range) continue;
    const days = billed.get(i.subscriptionId) ?? { live: [], cancelled: [] };
    (i.cancelledAt ? days.cancelled : days.live).push(range);
    billed.set(i.subscriptionId, days);
  }

  let created = 0;
  let reminded = 0;
  let failed = 0;
  for (const sub of subs) {
    try {
      for (const due of dueInvoices(sub, today, issued, billed.get(sub.id))) {
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
              // dates, not the key: "2026-W41" names no days to whoever has to invoice them
              { titleSuffix: periodLabel(due.key) },
            );
            if (raised) reminded++;
          }
        } catch (err) {
          // a concurrent sweep issued the same (subscription, period) first → skip
          if ((err as { code?: string }).code !== "P2002") throw err;
        }
      }
    } catch (err) {
      failed++;
      /**
       * The failure is isolated per subscription so one bad row cannot stop the firm's billing run.
       * That is right — and it is also how a client goes months without an invoice while every
       * night's job reports "ok". `JobEvent` counts them; this names the one that failed, on the
       * client's card, where somebody would actually meet it.
       */
      record("subscription.generation_failed", {
        outcome: "failed",
        subjectId: sub.id,
        subjectLabel: sub.service?.name ?? null,
        clientId: sub.clientId,
        changes: { error: err instanceof Error ? err.message : String(err) },
      });
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
