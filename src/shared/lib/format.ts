/**
 * Display formatters shared by every screen. Dates were formatted with the same
 * `toLocaleDateString("en-GB")` one-liner in nine places before this file existed — one rule
 * here means Billing, the board and a client card can never drift apart.
 */

/** dd/mm/yyyy — the app's date format (tables, rows, detail fields). */
export const fmtDate = (iso: string | Date) => new Date(iso).toLocaleDateString("en-GB");

/** dd/mm — compact, for board cards and tight rows. */
export const fmtDay = (iso: string | Date) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });

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
