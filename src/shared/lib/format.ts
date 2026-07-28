/**
 * Display formatters shared by every screen. Dates were formatted with the same
 * `toLocaleDateString("en-GB")` one-liner in nine places before this file existed — one rule
 * here means Billing, the board and a client card can never drift apart.
 *
 * TWO KINDS OF DATE, and mixing them up shifts a day (2026-07-27):
 *
 * - a TIMESTAMP is an instant — "created at", "sent at", "cancelled at". It happened at a moment
 *   in time, so it is rendered in the VIEWER's timezone: `fmtDate`.
 * - a BUSINESS DATE is a calendar day — a deadline, a due date, a payment date. It is stored at
 *   UTC midnight (decision 2026-07-17), so rendering it in the viewer's timezone shows the DAY
 *   BEFORE for anyone west of UTC: `2026-07-28T00:00:00Z` reads as 27/07 in New York. Those use
 *   `fmtBizDate` / `fmtBizDay`, which read the day off the UTC clock and so print the same day
 *   everywhere on earth — matching `shared/dates.ts`, which compares them the same way.
 */

/** dd/mm/yyyy in the VIEWER's timezone — for timestamps (createdAt, sentAt, cancelledAt). */
export const fmtDate = (iso: string | Date) => new Date(iso).toLocaleDateString("en-GB");

/** dd/mm/yyyy of a BUSINESS DATE (deadline, due date, payment date) — same day in every timezone. */
export const fmtBizDate = (iso: string | Date) =>
  new Date(iso).toLocaleDateString("en-GB", { timeZone: "UTC" });

/** dd/mm of a BUSINESS DATE — compact, for board cards and tight rows. */
export const fmtBizDay = (iso: string | Date) =>
  new Date(iso).toLocaleDateString("en-GB", { timeZone: "UTC", day: "2-digit", month: "2-digit" });

/** Today as "YYYY-MM-DD" — the value a `<input type="date">` expects. */
export const todayIso = () => isoDay(new Date());

/** `days` from today as "YYYY-MM-DD" — deadline presets ("Today", "+3 days", …). */
export const todayPlus = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return isoDay(d);
};

/** A Date → "YYYY-MM-DD" in the VIEWER's calendar (not UTC — "today" must mean their today). */
function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Two-letter initials for an avatar chip. */
export const initials = (u?: { firstName?: string | null; lastName?: string | null } | null) =>
  u ? `${u.firstName?.[0] ?? ""}${u.lastName?.[0] ?? ""}`.toUpperCase() || "?" : "?";
