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
