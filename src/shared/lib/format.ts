import { firmTimezone, firmToday } from "./tz";

/**
 * Display formatters shared by every screen. Dates were formatted with the same
 * `toLocaleDateString("en-GB")` one-liner in nine places before this file existed — one rule
 * here means Billing, the board and a client card can never drift apart.
 *
 * TWO KINDS OF DATE, and mixing them up shifts a day (2026-07-27):
 *
 * - a TIMESTAMP is an instant — "created at", "sent at", a meeting's start. It happened at a
 *   moment in time, and is rendered on the FIRM's clock (`fmtDate`, `fmtDateTime`, `fmtTime`).
 *   Not the viewer's: one office, one answer to "when is the meeting" (decision 2026-08-06).
 * - a BUSINESS DATE is a calendar day — a deadline, a due date, a payment date. It is stored at
 *   UTC midnight (decision 2026-07-17), so rendering it in the viewer's timezone shows the DAY
 *   BEFORE for anyone west of UTC: `2026-07-28T00:00:00Z` reads as 27/07 in New York. Those use
 *   `fmtBizDate` / `fmtBizDay`, which read the day off the UTC clock and so print the same day
 *   everywhere on earth — matching `shared/dates.ts`, which compares them the same way.
 */

/** dd/mm/yyyy of an INSTANT, on the FIRM's clock (createdAt, sentAt, cancelledAt). */
export const fmtDate = (iso: string | Date) =>
  new Date(iso).toLocaleDateString("en-GB", { timeZone: firmTimezone() });

/**
 * dd/mm/yyyy HH:MM of an INSTANT. For logs, where several entries land on one day and the date
 * alone reads as if they all happened at once.
 */
export const fmtDateTime = (iso: string | Date) =>
  new Date(iso).toLocaleString("en-GB", {
    timeZone: firmTimezone(),
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** HH:MM of an INSTANT on the firm's clock — the calendar's times. */
export const fmtTime = (iso: string | Date) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: firmTimezone(),
    hour: "2-digit",
    minute: "2-digit",
  });

/** dd/mm/yyyy of a BUSINESS DATE (deadline, due date, payment date) — same day in every timezone. */
export const fmtBizDate = (iso: string | Date) =>
  new Date(iso).toLocaleDateString("en-GB", { timeZone: "UTC" });

/** dd/mm of a BUSINESS DATE — compact, for board cards and tight rows. */
export const fmtBizDay = (iso: string | Date) =>
  new Date(iso).toLocaleDateString("en-GB", { timeZone: "UTC", day: "2-digit", month: "2-digit" });

/** Today as "YYYY-MM-DD" on the FIRM's calendar — the value a `<input type="date">` expects. */
export const todayIso = () => firmToday();

/** `days` from today as "YYYY-MM-DD" — deadline presets ("Today", "+3 days", …). */
export const todayPlus = (days: number) => {
  // counted from the FIRM's today, so "+3 days" means the same to everyone in the office
  const [y, m, d] = firmToday().split("-").map(Number);
  return isoDay(new Date(y, m - 1, d + days));
};

/** A Date → "YYYY-MM-DD" in the VIEWER's calendar (not UTC — "today" must mean their today). */
export function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Two-letter initials for an avatar chip. */
export const initials = (u?: { firstName?: string | null; lastName?: string | null } | null) =>
  u ? `${u.firstName?.[0] ?? ""}${u.lastName?.[0] ?? ""}`.toUpperCase() || "?" : "?";

/**
 * A file's size, in the unit that actually says something.
 *
 * Both file lists divided by a megabyte and rounded to one decimal, so anything under 50 KB — a
 * signed form, a text note, most scans of one page — read as "0.0 MB", which looks like an empty
 * file rather than a small one (2026-08-28).
 */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
