/**
 * "Was this subscription being served on day X?" — the one question both sweeps ask.
 *
 * The task sweep asks it per occurrence date; the billing sweep asks it across a whole period.
 * Before this existed each half answered from a different field (billing from `billingStartAt`,
 * tasks from `subscription.createdAt`), which is how a pause could be unbilled and yet fully
 * worked. Everything about served time now goes through here.
 *
 * Periods are HALF-OPEN: `startsOn` is the first day in force, `endsBefore` the first day that is
 * not. `endsBefore = null` means open-ended, which is the normal state — nothing expires a
 * subscription except a person pausing it. The half-open shape is what makes pause-and-resume on
 * the same day leave no gap: [.., 20th) followed by [20th, ..) is continuous.
 *
 * Days are compared as UTC day numbers. The stored columns are `DATE`, so no time-of-day can get
 * in, and UTC has no DST — the arithmetic can't drift the way local-time arithmetic does.
 */
import type { Prisma } from "../generated/prisma/client.js";
import { type Day, todayInTz, toUtc } from "./dates.js";

export interface InForcePeriod {
  startsOn: Date;
  endsBefore: Date | null;
}

/** Whole days since the epoch — the scale every comparison here runs on. */
const dayNumber = (date: Date): number =>
  Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000,
  );

const dayNumberOf = (day: Day): number => dayNumber(toUtc(day));

/** `[start, end)` in day numbers; `end = Infinity` for an open period. */
const asRange = (p: InForcePeriod): [number, number] => [
  dayNumber(p.startsOn),
  p.endsBefore ? dayNumber(p.endsBefore) : Number.POSITIVE_INFINITY,
];

/** Was the subscription in force on this calendar day? */
export function inForceOn(periods: InForcePeriod[], day: Day): boolean {
  const d = dayNumberOf(day);
  return periods.some((p) => {
    const [start, end] = asRange(p);
    return d >= start && d < end;
  });
}

export type Coverage = "full" | "partial" | "none";

/**
 * How much of `[from .. through]` (both INCLUSIVE) the subscription was in force for.
 *
 * The billing rule is `coverage(...) === "full"`: a period is invoiced automatically only when the
 * subscription was in force continuously from the period's first day through its trigger day.
 * `"partial"` is what raises the manual-invoice reminder; `"none"` means the period simply never
 * belonged to this subscription and nothing at all happens.
 */
export function coverage(periods: InForcePeriod[], from: Day, through: Day): Coverage {
  const start = dayNumberOf(from);
  const end = dayNumberOf(through) + 1; // exclusive, so the range is [start, end)
  if (end <= start) return "none";

  // merge overlapping/touching ranges first — the service forbids overlaps, but a coverage answer
  // must not depend on that holding
  const ranges = periods
    .map(asRange)
    .map(([s, e]): [number, number] => [Math.max(s, start), Math.min(e, end)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  if (ranges.length === 0) return "none";

  let covered = 0;
  let cursor = ranges[0][0];
  let reach = ranges[0][0];
  for (const [s, e] of ranges) {
    if (s > reach) {
      covered += reach - cursor;
      cursor = s;
    }
    reach = Math.max(reach, e);
  }
  covered += reach - cursor;

  return covered === end - start ? "full" : "partial";
}

/**
 * The same question as `inForceOn`, expressed for SQL — a `Subscription` where-fragment.
 *
 * `active` used to be a stored boolean read by four queries: the billing sweep, the task sweep,
 * the clients list tabs and the default-service count. They all ask this instead now, so there is
 * one definition of "in force" rather than a column that some code path can forget to update.
 */
export function inForceTodayWhere(tz: string): Prisma.SubscriptionWhereInput {
  const today = toUtc(todayInTz(tz));
  return {
    periods: {
      some: {
        startsOn: { lte: today },
        OR: [{ endsBefore: null }, { endsBefore: { gt: today } }],
      },
    },
  };
}

/**
 * Subscriptions that have NOT ended — in force today, or agreed for a future date. This is the
 * set "the client's live services": it is what decides whether a service is their only one, and
 * therefore unambiguously their default (2026-08-01 audit).
 *
 * `inForceTodayWhere` is the stricter question, "is it running right now", and is what billing and
 * task generation ask. The two are deliberately different: a service starting on 1 October is not
 * generating anything yet, but it IS the client's service.
 */
export function notEndedWhere(tz: string): Prisma.SubscriptionWhereInput {
  const today = toUtc(todayInTz(tz));
  return { periods: { some: { OR: [{ endsBefore: null }, { endsBefore: { gt: today } }] } } };
}

/** Has a period that hasn't ended — in force today or scheduled. See `notEndedWhere`. */
export function notEnded(periods: InForcePeriod[], today: Day): boolean {
  const t = toUtc(today).getTime();
  return periods.some((p) => !p.endsBefore || p.endsBefore.getTime() > t);
}

/** The first day the subscription was ever in force, or null when it has no periods at all. */
export function firstDayInForce(periods: InForcePeriod[]): Day | null {
  if (periods.length === 0) return null;
  const earliest = periods.reduce((a, b) => (a.startsOn <= b.startsOn ? a : b)).startsOn;
  return {
    y: earliest.getUTCFullYear(),
    m: earliest.getUTCMonth() + 1,
    d: earliest.getUTCDate(),
  };
}
