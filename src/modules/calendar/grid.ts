/**
 * Grid maths for the calendar views. No zod, no React — just days and minutes.
 *
 * **Everything here runs on the FIRM's clock**, never the viewer's. The server decides which day a
 * meeting belongs to using the firm's zone, and this module places it within that day the same
 * way, so the two can never disagree. A laptop set to another timezone — travel, a VPN, a wrong
 * system setting — changes nothing about where a meeting is drawn (decision 2026-08-06).
 */

import { fmtTime, isoDay } from "@/shared/lib/format";
import {
  firmIsoDay,
  firmMinutesOfDay,
  firmToday,
  firmWallClockToInstant,
} from "@/shared/lib/tz";

export type ViewMode = "day" | "week" | "month";

// `isoDay` is re-exported so the views can import days and grid maths from one place; the
// implementation stays in shared/lib/format.ts, which had it first.
export { isoDay };

/**
 * The instant a clicked empty slot stands for: that day column, that hour row, ON THE FIRM'S CLOCK.
 *
 * It is a named function rather than three lines inside the button's `onClick` precisely because
 * those three lines were wrong and nothing could see it — `setHours` sets the hour in the viewer's
 * zone, so clicking 10:00 from Kyiv opened the form at 03:00 in the office (user, 2026-08-06).
 * Out here it is testable.
 */
export function slotInstant(dayIso: string, hour: number): string {
  return firmWallClockToInstant(`${dayIso}T${String(hour).padStart(2, "0")}:00`).toISOString();
}

/** Which day column a meeting belongs to — the firm's day, matching the server's own slicing. */
export const dayOfMeeting = (startAt: string): string => firmIsoDay(new Date(startAt));

/** Today, as the firm reckons it — what the grid highlights and what "Today" jumps to. */
export { firmToday };

/** The working day the grid shows when nothing falls outside it. */
export const DEFAULT_START_HOUR = 8;
export const DEFAULT_END_HOUR = 20;
/** the smallest box that fits one readable line, expressed in grid minutes */
const MIN_BOX_MINUTES = 34;
/** below this, the card shows one line instead of three */
const COMPACT_UNDER_MINUTES = 45;

export interface GridRange {
  startHour: number;
  endHour: number;
}

/**
 * The hours to draw for a given set of meetings.
 *
 * A fixed 08:00–20:00 meant anything outside it was pinned to the edge with an arrow: the label
 * read "03:00" while the box sat against the 08:00 line, so the position contradicted the text.
 * The range stretches instead — the ordinary day still looks like an ordinary day, and an early
 * call or a late one simply widens the grid rather than lying about where it is (user, 2026-08-06).
 */
export function rangeFor(meetings: { startAt: string; durationMinutes: number }[]): GridRange {
  let startHour = DEFAULT_START_HOUR;
  let endHour = DEFAULT_END_HOUR;
  for (const m of meetings) {
    const from = firmMinutesOfDay(new Date(m.startAt));
    startHour = Math.min(startHour, Math.floor(from / 60));
    // an event running past midnight is clamped to the end of its own day, not spilled into the next
    endHour = Math.max(endHour, Math.min(24, Math.ceil((from + m.durationMinutes) / 60)));
  }
  return { startHour, endHour };
}

export const addDays = (d: Date, n: number): Date => {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
};

/** Monday-first, which is what a Ukrainian office reads. */
export function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const shift = (out.getDay() + 6) % 7; // Sunday(0) → 6, Monday(1) → 0
  return addDays(out, -shift);
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/**
 * The window a view asks the server for: `[from, to)` as calendar days.
 *
 * The month view deliberately asks for whole WEEKS, because it draws whole weeks — the leading and
 * trailing days from the neighbouring months are real cells and must not be empty.
 */
export function windowFor(mode: ViewMode, anchor: Date): { from: string; to: string; days: Date[] } {
  if (mode === "day") {
    const d = new Date(anchor);
    d.setHours(0, 0, 0, 0);
    return { from: isoDay(d), to: isoDay(addDays(d, 1)), days: [d] };
  }
  if (mode === "week") {
    const start = startOfWeek(anchor);
    return {
      from: isoDay(start),
      to: isoDay(addDays(start, 7)),
      days: Array.from({ length: 7 }, (_, i) => addDays(start, i)),
    };
  }
  const gridStart = startOfWeek(startOfMonth(anchor));
  // 6 rows always: a month can span 6 weeks, and a grid that changes height every month jumps
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  return { from: isoDay(gridStart), to: isoDay(addDays(gridStart, 42)), days };
}

/**
 * Where a meeting sits in the hour grid, as percentages of the drawn range.
 *
 * Everything is clamped INTO the grid. An 07:00 breakfast and a 21:00 call are both real, and
 * neither may be positioned outside its container — the browser would happily draw them over the
 * next day's column, or off the panel entirely. They are pinned to the edge and flagged, so the
 * card can say "starts earlier" rather than lie about the time.
 */
export function placeInGrid(startAt: string, durationMinutes: number, range: GridRange) {
  const GRID_MINUTES = (range.endHour - range.startHour) * 60;
  // the firm's wall clock — `getHours()` would answer in whatever zone the viewer's machine is on
  const offsetMin = firmMinutesOfDay(new Date(startAt)) - range.startHour * 60;
  const top = Math.min(Math.max(offsetMin, 0), GRID_MINUTES);
  const rawEnd = offsetMin + durationMinutes;
  const end = Math.min(Math.max(rawEnd, top), GRID_MINUTES);
  // A 15-minute meeting is 13 pixels tall in this grid — too short for even one line of text, so
  // it rendered clipped and overlapping its neighbour. The box gets a readable MINIMUM regardless
  // of the real duration; `compact` tells the card to drop to a single line instead of three.
  const height = Math.max(Math.min(end - top, GRID_MINUTES - top), Math.min(MIN_BOX_MINUTES, GRID_MINUTES - top));
  return {
    topPct: (top / GRID_MINUTES) * 100,
    heightPct: (height / GRID_MINUTES) * 100,
    /** it began before the drawn range — the card says so instead of silently moving */
    clippedStart: offsetMin < 0,
    /** it runs past the drawn range */
    clippedEnd: rawEnd > GRID_MINUTES,
    /** too short to carry title + time + client on separate lines */
    compact: durationMinutes < COMPACT_UNDER_MINUTES,
  };
}

/**
 * Lay overlapping meetings side by side.
 *
 * Without this two meetings at the same hour sit exactly on top of each other and the one
 * underneath is invisible — which is precisely the case the conflict warning exists to surface,
 * so hiding it here would be the worst place to cut a corner.
 */
export function columnsFor<T extends { startAt: string; durationMinutes: number }>(
  items: T[],
): { item: T; column: number; columns: number }[] {
  const sorted = [...items].sort(
    (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
  );
  const endOf = (m: T) => new Date(m.startAt).getTime() + m.durationMinutes * 60_000;

  const out: { item: T; column: number; columns: number }[] = [];
  let cluster: T[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    // within a cluster, first free column wins — the usual greedy lane assignment
    const laneEnds: number[] = [];
    const placed = cluster.map((m) => {
      const start = new Date(m.startAt).getTime();
      let lane = laneEnds.findIndex((end) => end <= start);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = endOf(m);
      return { item: m, column: lane };
    });
    const columns = laneEnds.length || 1;
    out.push(...placed.map((p) => ({ ...p, columns })));
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const m of sorted) {
    const start = new Date(m.startAt).getTime();
    if (cluster.length > 0 && start >= clusterEnd) flush();
    cluster.push(m);
    clusterEnd = Math.max(clusterEnd, endOf(m));
  }
  if (cluster.length > 0) flush();
  return out;
}

/**
 * `fmtTime` is the shared one from `format.ts` — it already renders on the firm's clock, and a
 * second local copy is exactly how the two would drift.
 */
/**
 * "10:00–11:00", or "23:57–00:57 +1" when it runs into the next day.
 *
 * The `+1` is not decoration: a meeting ending at 00:57 reads as if it finished before it started
 * unless something says the end is tomorrow. It is drawn only on the day it BEGINS — a calendar
 * shows you when to be somewhere, and that is the start.
 */
export const fmtRange = (iso: string, minutes: number): string => {
  const start = new Date(iso);
  const end = new Date(start.getTime() + minutes * 60_000);
  const nextDay = firmIsoDay(end) !== firmIsoDay(start);
  return `${fmtTime(start)}–${fmtTime(end)}${nextDay ? " +1" : ""}`;
};

export { fmtTime };
