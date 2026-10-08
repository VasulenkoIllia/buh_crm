import type { BillingPeriod } from "./schema/enums.js";
import { type CalendarDay, isoWeek, isoWeekMonday } from "./dates.js";

/**
 * **What a period key stands for**, whichever rhythm wrote it (payments.md §4).
 *
 * The period sweep keys every invoice it issues by its period: `2026-10`, `2026-Q4`, `2026`, and
 * since 2026-10-07 `2026-W41` for a week and `2026-10-H1` / `2026-10-H2` for the halves of a month.
 * The key is what keeps a period from being billed twice, but only against the SAME key. A
 * subscription moved from monthly to quarterly on 7 October would be billed for Q4 although October
 * was already invoiced, because `2026-Q4` and `2026-10` are different strings (found 2026-10-07).
 * Reading a key back into its days lets the sweep compare what periods COVER, whatever wrote them.
 *
 * Shared, not the server's: the screens print the same periods as dates.
 */

export type { CalendarDay } from "./dates.js";

export interface PeriodRange {
  start: CalendarDay;
  end: CalendarDay;
}

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");

/** The key of the ISO week a day falls in: `2026-W41`. Weeks run Monday to Sunday. */
export function weekKey(day: CalendarDay): string {
  const { year, week } = isoWeek(day);
  return `${year}-W${pad(week)}`;
}

/** The first and last day a key covers, both inclusive; null for a key no rhythm writes. */
export function periodRange(key: string): PeriodRange | null {
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    return { start: { y, m, d: 1 }, end: { y, m, d: lastDay(y, m) } };
  }
  const half = /^(\d{4})-(0[1-9]|1[0-2])-H([12])$/.exec(key);
  if (half) {
    const y = Number(half[1]);
    const m = Number(half[2]);
    return half[3] === "1"
      ? { start: { y, m, d: 1 }, end: { y, m, d: 15 } }
      : { start: { y, m, d: 16 }, end: { y, m, d: lastDay(y, m) } };
  }
  const week = /^(\d{4})-W(\d{2})$/.exec(key);
  if (week) {
    const year = Number(week[1]);
    const n = Number(week[2]);
    const monday = isoWeekMonday(year, n);
    // a week number the year does not have (W00, or W53 in a 52-week year) names no week
    if (n < 1 || weekKey(monday) !== key) return null;
    const sunday = new Date(Date.UTC(monday.y, monday.m - 1, monday.d + 6));
    return {
      start: monday,
      end: { y: sunday.getUTCFullYear(), m: sunday.getUTCMonth() + 1, d: sunday.getUTCDate() },
    };
  }
  const quarter = /^(\d{4})-Q([1-4])$/.exec(key);
  if (quarter) {
    const y = Number(quarter[1]);
    const first = (Number(quarter[2]) - 1) * 3 + 1;
    return { start: { y, m: first, d: 1 }, end: { y, m: first + 2, d: lastDay(y, first + 2) } };
  }
  const year = /^(\d{4})$/.exec(key);
  if (year) {
    const y = Number(year[1]);
    return { start: { y, m: 1, d: 1 }, end: { y, m: 12, d: 31 } };
  }
  return null;
}

/**
 * What one invoice of a subscription bills.
 *
 * Twice a month is the one rhythm whose price is not per invoice: the firm agrees a MONTHLY rate
 * and bills it in halves on the 15th and the last day (owner, 2026-10-07). The odd cent goes to the
 * second half, so the two always add up to the month exactly. Every other rhythm bills its price.
 */
export function invoiceAmount(period: BillingPeriod, amount: number, key: string): number {
  if (period !== "half_month") return amount;
  const [first, second] = halvesOf(amount);
  return key.endsWith("-H1") ? first : second;
}

/** A monthly price in its two invoices, the odd cent on the second: they add up to it exactly. */
export function halvesOf(amount: number): [first: number, second: number] {
  const first = Math.floor(amount / 2);
  return [first, amount - first];
}

/**
 * Why a subscription's billing day cannot stand, or null when it can.
 *
 * `invoiceDay` means a different thing per rhythm: the day of the period's first month (1–31) for
 * a month, a quarter or a year; the day of the week (1–7, Monday = 1) for a week, the convention
 * the task rhythms already use; and nothing at all twice a month, which always bills on the 15th
 * and the last day. One column with three meanings is checked here, on the merged row, by the
 * server, and asked by the form before it sends.
 */
export function billingDayProblem(
  period: BillingPeriod | null,
  trigger: string | null | undefined,
  day: number | null | undefined,
): string | null {
  if (day == null) return null;
  if (period === "half_month") {
    return "Twice a month bills on the 15th and the last day, so it takes no custom day";
  }
  if (trigger !== "on_period_start") {
    return "A custom day only applies when billing at the start of the period";
  }
  if (period === "week" && (day < 1 || day > 7)) return "Pick a day of the week";
  return null;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * **A period as a person reads it**: "Oct 2026", "1–15 Oct 2026", "5–11 Oct 2026", "Q4 2026".
 *
 * A key is for the database; `2026-W41` says nothing about which days were billed, and the halves
 * and the weeks of 2026-10-07 made that the common case rather than the odd one (owner chose dates,
 * 2026-10-07). A week across two months or two years names both ends. A key no rhythm writes is
 * shown as it is, never hidden.
 */
export function periodLabel(key: string): string {
  const range = periodRange(key);
  if (!range) return key;
  const { start: a, end: b } = range;
  if (/-Q[1-4]$/.test(key)) return `${key.slice(5)} ${a.y}`;
  if (/^\d{4}$/.test(key)) return key;
  // a whole month
  if (a.d === 1 && b.m === a.m && b.y === a.y && b.d === lastDay(b.y, b.m)) {
    return `${MONTHS[a.m - 1]} ${a.y}`;
  }
  const month = (d: CalendarDay) => MONTHS[d.m - 1];
  if (a.y !== b.y) return `${a.d} ${month(a)} ${a.y} – ${b.d} ${month(b)} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${month(a)} – ${b.d} ${month(b)} ${b.y}`;
  return `${a.d}–${b.d} ${month(a)} ${a.y}`;
}
