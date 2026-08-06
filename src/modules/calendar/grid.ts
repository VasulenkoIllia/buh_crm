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

// re-exported so a view can take days, times and grid maths from one place; the implementations
// stay where they belong
export { firmToday, fmtTime, isoDay };

/**
 * The grid is always the WHOLE DAY, and it scrolls.
 *
 * Two earlier designs were worse. A fixed 08:00–20:00 pinned anything outside it to the edge with
 * an arrow, so a 03:00 meeting was labelled 03:00 while sitting on the 08:00 line. Stretching the
 * range to fit whatever was loaded fixed that and broke something worse: the geometry then differed
 * from day to day — Thursday started at 03:00 and Friday at 08:00, the same hour sat at a different
 * height on each, and one late meeting pushed everything else off the screen (user, 2026-08-06).
 *
 * A full fixed day is what every calendar does. Nothing is ever clamped, nothing shifts when you
 * change day, and a meeting at 23:57 is drawn at 23:57 — you scroll to it. The view opens on the
 * working hours, which is the only part of "stretch to fit" worth keeping.
 */
export const DAY_START_HOUR = 0;
export const DAY_END_HOUR = 24;
const GRID_MINUTES = (DAY_END_HOUR - DAY_START_HOUR) * 60;

/** where the scroll sits when the view opens — the working day, not midnight */
export const OPENING_HOUR = 8;

/** the smallest box that fits one readable line, expressed in grid minutes */
const MIN_BOX_MINUTES = 34;
/** below this, the card shows one line instead of three */
const COMPACT_UNDER_MINUTES = 45;

export const addDays = (d: Date, n: number): Date => {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
};

/** Monday-first, which is what this office reads. */
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

/** Where a meeting sits in the day, as percentages of it. */
export function placeInGrid(startAt: string, durationMinutes: number) {
  // the firm's wall clock — `getHours()` would answer in whatever zone the viewer's machine is on
  const offsetMin = firmMinutesOfDay(new Date(startAt));
  const top = Math.min(Math.max(offsetMin, 0), GRID_MINUTES);
  const rawEnd = offsetMin + durationMinutes;
  const end = Math.min(Math.max(rawEnd, top), GRID_MINUTES);
  // a sliver is still clickable; never let the floor push the box past the bottom
  const height = Math.max(
    Math.min(end - top, GRID_MINUTES - top),
    Math.min(MIN_BOX_MINUTES, GRID_MINUTES - top),
  );
  return {
    topPct: (top / GRID_MINUTES) * 100,
    heightPct: (height / GRID_MINUTES) * 100,
    /** cannot happen for something that starts on this day — kept as a guard */
    clippedStart: offsetMin < 0,
    /** it runs past midnight; the box stops at the end of the day and the label says "+1" */
    clippedEnd: rawEnd > GRID_MINUTES,
    /** too short to carry title, time and client on separate lines */
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
