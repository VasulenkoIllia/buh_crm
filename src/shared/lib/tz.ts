/**
 * The firm's clock, on the browser side.
 *
 * The whole product answers "what time is it" with ONE zone — the firm's, from `TZ` in the
 * environment — and the browser must give the same answer as the scheduler. Before this, instants
 * were rendered in whatever zone the viewer's machine was set to, so a meeting saved as 09:00 in
 * the office read as 02:00 to someone whose laptop was on New York time and 07:00 in London.
 * Calendar days were never affected — those are stored at UTC midnight and formatted against UTC —
 * which is why the seam stayed invisible until the calendar started drawing real instants.
 *
 * It is a module-level value rather than React context because it is a property of the FIRM, not
 * of a screen: every formatter in the app would otherwise need a hook threaded through it. It is
 * set once, from the settings the app already loads at boot, and the default matches the server's
 * so the first paint is right even before that arrives.
 */

let firmTz = "America/New_York";

/** Called once when settings arrive. Returns true if the value actually changed. */
export function setFirmTimezone(tz: string): boolean {
  if (!tz || tz === firmTz) return false;
  firmTz = tz;
  return true;
}

export const firmTimezone = (): string => firmTz;

/** e.g. "EST" / "EDT" — what to print next to a time so it is unambiguous. */
export function firmZoneAbbr(at: Date = new Date()): string {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: firmTz,
    timeZoneName: "short",
  })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

/**
 * The wall-clock the firm sees at a given instant, broken into parts.
 *
 * This is the primitive everything else needs: `Date#getHours()` answers in the viewer's zone, and
 * there is no built-in that answers in another one.
 */
export function firmParts(at: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: firmTz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return {
    year: n("year"),
    month: n("month"),
    day: n("day"),
    hour: n("hour"),
    minute: n("minute"),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of the calendar day this instant falls on IN THE FIRM'S ZONE. */
export function firmIsoDay(at: Date): string {
  const p = firmParts(at);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes past midnight, on the firm's clock. What positions a meeting in the hour grid. */
export function firmMinutesOfDay(at: Date): number {
  const p = firmParts(at);
  return p.hour * 60 + p.minute;
}

/** Today, as the firm reckons it. Not the viewer's today. */
export const firmToday = (): string => firmIsoDay(new Date());

/**
 * How far the firm's zone is from UTC at that instant, in ms. DST-correct because it asks what
 * wall-clock the zone was showing rather than assuming a fixed offset.
 */
function firmOffsetMs(at: Date): number {
  const p = firmParts(at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

/**
 * A wall-clock reading in the firm's zone → the instant it names.
 *
 * The inverse of `firmParts`, and the piece a form needs: `<input type="datetime-local">` hands
 * back "2026-08-19T09:00" with no zone attached, and `new Date(...)` on that string reads it in
 * the BROWSER's zone. Typing 09:00 in the office must mean 09:00 in the office, whoever is typing.
 *
 * Two passes, because the offset depends on the date: the first guess lands near the right instant,
 * and asking the zone again from there settles it across a daylight-saving change.
 */
export function firmWallClockToInstant(local: string): Date {
  const asIfUtc = new Date(`${local.length === 16 ? local : local.slice(0, 16)}:00.000Z`);
  const first = new Date(asIfUtc.getTime() - firmOffsetMs(asIfUtc));
  return new Date(asIfUtc.getTime() - firmOffsetMs(first));
}

/** An instant → the "YYYY-MM-DDTHH:mm" a `datetime-local` input expects, on the firm's clock. */
export function instantToFirmWallClock(at: Date | string): string {
  const p = firmParts(at instanceof Date ? at : new Date(at));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
