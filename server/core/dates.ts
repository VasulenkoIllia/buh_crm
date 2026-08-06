/**
 * Business-date helpers. Dates are calendar days in the FIRM timezone, stored as UTC
 * midnight (decision 2026-07-17: UTC storage + firm-TZ business dates). Shared by the
 * scheduler sweeps (task rhythms, billing periods) so both count days the same way.
 */

export interface Day {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

/**
 * Which calendar day an INSTANT falls on, in the firm's timezone, as "YYYY-MM-DD".
 *
 * Not `at.toISOString().slice(0, 10)` — that reads the day off the UTC clock, so at UTC+3 every
 * instant before 03:00 reports the day before. A meeting booked for 00:30 on the 19th produced a
 * task due on the 18th: due before the thing it was preparing for (found 2026-08-06).
 */
export function isoDayInTz(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at); // en-CA renders YYYY-MM-DD
}

/** Today's calendar date in the firm timezone. */
export function todayInTz(tz: string): Day {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()); // YYYY-MM-DD
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

/** The calendar date an instant falls on in the firm timezone. */
export function fromDate(date: Date, tz: string): Day {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

export const toUtc = ({ y, m, d }: Day) => new Date(Date.UTC(y, m - 1, d));

/** <0 a before b · 0 same day · >0 a after b */
export const cmp = (a: Day, b: Day) => toUtc(a).getTime() - toUtc(b).getTime();

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** day 1-31 clamped to the month; -1/overflow = last day. */
export function calendarDay(y: number, m: number, day: number | null): Day {
  const last = daysInMonth(y, m);
  const d = day == null ? 1 : day === -1 ? last : Math.min(day, last);
  return { y, m, d };
}

export const addDays = (day: Day, n: number): Day => {
  const date = toUtc(day);
  date.setUTCDate(date.getUTCDate() + n);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
};

/** ISO-8601 week (year + number) of a date. */
export function isoWeek(day: Day): { year: number; week: number } {
  const date = toUtc(day);
  const dow = date.getUTCDay() || 7; // Mon=1..Sun=7
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 4 - dow);
  const year = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((thursday.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return { year, week };
}

/** Monday of an ISO week. */
export function isoWeekMonday(year: number, week: number): Day {
  const jan4 = new Date(Date.UTC(year, 0, 4)); // always in week 1
  const dow = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - dow + 1 + (week - 1) * 7);
  return { y: monday.getUTCFullYear(), m: monday.getUTCMonth() + 1, d: monday.getUTCDate() };
}

/** DD.MM.YYYY — the label format used in generated titles. */
export const dayLabel = ({ y, m, d }: Day) =>
  `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;

/** "YYYY-MM-DD" from the API (a business date) → the UTC midnight we store it at. */
export const dateToUtc = (d: string) => new Date(`${d}T00:00:00Z`);

/**
 * Today as a business date, in the FIRM timezone — the value `deriveStatus` / `isTaskOverdue`
 * and the Billing overdue filter all compare against. Read from `config.TZ` rather than the
 * process timezone, for the same reason the scheduler pins its cron timezone explicitly.
 */
export const todayBusinessMs = (tz: string) => toUtc(todayInTz(tz)).getTime();

/**
 * How far the zone is ahead of UTC at that instant, in ms. DST-correct because it asks the
 * zone what wall-clock time it was showing, rather than assuming a fixed offset.
 */
function zoneOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) -
    Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The INSTANT at which a calendar day begins in the firm's timezone — midnight in Kyiv, not
 * midnight UTC.
 *
 * This is not the same helper as `dateToUtc`, and using the wrong one is a silent bug. A stored
 * DATE (a deadline, a due date, a period boundary) is a calendar day pinned to UTC midnight, and
 * `dateToUtc` is right for those. A meeting is a real instant, so slicing a day of meetings on UTC
 * midnight would, at UTC+3, hand back a window shifted three hours — quietly dropping every
 * meeting before 03:00 and pulling in the tail of the previous day.
 *
 * Two passes, because the offset itself depends on the date: the first guess lands somewhere in
 * the right day, and asking the zone again from there settles it across a DST change.
 */
export function zonedDayStart(dayIso: string, tz: string): Date {
  const utcMidnight = new Date(`${dayIso}T00:00:00.000Z`);
  const first = new Date(utcMidnight.getTime() - zoneOffsetMs(utcMidnight, tz));
  const settled = zoneOffsetMs(first, tz);
  return new Date(utcMidnight.getTime() - settled);
}
