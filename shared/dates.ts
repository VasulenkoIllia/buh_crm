/**
 * Business dates — the one rule both sides count days by.
 *
 * A deadline or a due date is a CALENDAR DAY, not an instant: "due 26.07.2026" means the
 * whole of that day. Those days are stored as UTC midnight (decision 2026-07-17: UTC storage
 * + firm-TZ business dates), so comparing them as instants against `Date.now()` marks
 * anything due TODAY as already late from 00:00 — which is what this module exists to prevent.
 *
 * Everything here works on "business-date milliseconds": the UTC-midnight instant of a
 * calendar day. Comparing two of those is an exact day comparison in any timezone.
 */

/** The UTC-midnight instant of the calendar day a stored business date sits on. */
export function businessDateMs(date: Date | string): number {
  const d = date instanceof Date ? date : new Date(date);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Today as a business date, read from the VIEWER's calendar (the browser's local day, or the
 * server process's day) and projected onto the UTC-midnight scale so it compares with stored
 * dates. Server code that must not depend on the process timezone passes its own value —
 * see `todayBusinessMs` in `server/core/dates.ts`, which reads the firm timezone explicitly.
 */
export function localBusinessTodayMs(now: Date = new Date()): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Has the whole of `date`'s day passed? An item due today is NOT past — it is due today.
 * `todayMs` is a business-date value (see above); it defaults to the viewer's today.
 */
export function isPastBusinessDate(
  date: Date | string | null | undefined,
  todayMs: number = localBusinessTodayMs(),
): boolean {
  if (date == null) return false;
  return todayMs > businessDateMs(date);
}

/**
 * Overdue = still open and the whole DEADLINE DAY has passed. A task due today is due today,
 * not late — the same rule invoices use (`deriveStatus`), so the red ring on the board and the
 * ⚠ on an invoice never disagree about what "late" means.
 *
 * It lives here, next to the rule, rather than in `schema/task.ts`: this module is zod-free, and
 * importing a VALUE out of a schema module pulls the whole schema runtime into the browser
 * bundle (measured: +433 kB). Schema modules stay type-only imports on the frontend.
 */
export function isTaskOverdue(
  task: { done: boolean; deadline: string | Date | null },
  todayMs: number = localBusinessTodayMs(),
): boolean {
  return !task.done && isPastBusinessDate(task.deadline, todayMs);
}

/**
 * "Tue 9 Sept, 14:30" and "9 Sept" — the way this app writes a date to a person.
 *
 * `tz` is a parameter rather than a lookup so this file stays dependency-free and usable from both
 * sides. The server passes the firm's zone; a business date is always reckoned on it.
 *
 * It exists because the same `Intl.DateTimeFormat` call was written out three times — once in the
 * meetings service, twice inside the notification sweep — and the one place that DIDN'T do it sent
 * `Was due 2026-09-01` to a reader, which is a machine's date in a human sentence
 * (audit, 2026-09-08).
 */
/**
 * **Which zone to pass, and it is not a style choice.**
 *
 * A *business date* — a task deadline, an invoice due day — is stored at **UTC midnight** and
 * carries no time of day. Render it with `"UTC"`. Rendering it in the firm's zone moves it: a
 * deadline of 2026-09-01 shown in America/New_York reads "31 Aug", and a task due the 1st tells
 * its assignee it was due the 31st (regression, 2026-09-08).
 *
 * An *instant* — a meeting's `startAt`, a timer's start — is a real moment. Render it with the
 * firm's zone, which is what a person means by "half past two".
 */
export function fmtDayInTz(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    day: "numeric",
    month: "short",
  }).format(at);
}

export function fmtDayTimeInTz(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

export function fmtTimeInTz(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}
