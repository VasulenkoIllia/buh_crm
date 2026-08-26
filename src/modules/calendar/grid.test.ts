import { beforeAll, describe, expect, it } from "vitest";
import {
  firmMinutesOfDay,
  firmWallClockToInstant,
  instantToFirmWallClock,
  setFirmTimezone,
} from "@/shared/lib/tz";
import {
  columnsFor,
  drawnEndMs,
  MIN_BOX_MINUTES,
  dayOfMeeting,
  fmtRange,
  placeInGrid,
  slotInstant,
  startOfWeek,
  windowFor,
} from "./grid.js";

/**
 * Times are the FIRM's wall clock, because that is what the grid draws.
 *
 * Writing them in the machine's local zone — or in UTC — makes the test pass or fail depending on
 * where it runs, which is a broken test rather than a broken grid. Going through the same
 * conversion the app uses means these assertions hold on any developer's laptop and in CI.
 */
beforeAll(() => setFirmTimezone("America/New_York"));

const pad = (n: number) => String(n).padStart(2, "0");
const localAt = (h: number, min = 0, day = 5) =>
  firmWallClockToInstant(`2026-08-${pad(day)}T${pad(h)}:${pad(min)}`).toISOString();

const m = (startAt: string, durationMinutes: number, id = startAt) => ({
  id,
  startAt,
  durationMinutes,
});

describe("calendar grid", () => {
  it("a clicked slot names the FIRM's hour, not the viewer's", () => {
    /**
     * The bug this pins: the grid moved to the firm's clock but the slot handler still built its
     * instant with `setHours`, which sets the hour in the BROWSER's zone. Clicking 10:00 from Kyiv
     * opened the form at 03:00 — the office's 10:00 is Kyiv's 17:00 (user, 2026-08-06).
     *
     * The click builds `${day}T${hour}:00` and puts it through the firm's clock; this asserts the
     * round trip lands back on the same hour, whatever zone the test machine is on.
     */
    for (const hour of [3, 8, 10, 17, 23]) {
      const instant = new Date(slotInstant("2026-08-05", hour));
      // the form opens on the hour that was clicked, and the grid draws it back in the same row
      expect(instantToFirmWallClock(instant)).toBe(
        `2026-08-05T${String(hour).padStart(2, "0")}:00`,
      );
      expect(firmMinutesOfDay(instant)).toBe(hour * 60);
      expect(dayOfMeeting(instant.toISOString())).toBe("2026-08-05");
    }
  });

  it("says when a meeting ends on the next day", () => {
    // 23:57 + 60 min ends at 00:57 — without a marker that reads as ending before it started
    expect(fmtRange(localAt(23, 57), 60)).toMatch(/23:57–00:57 \+1$/);
    expect(fmtRange(localAt(10), 60)).toBe("10:00–11:00");
    // exactly midnight is still the next day
    expect(fmtRange(localAt(23), 60)).toMatch(/\+1$/);
    // …and one minute short of it is not
    expect(fmtRange(localAt(23), 59)).not.toMatch(/\+1$/);
  });

  it("starts the week on Monday", () => {
    // 2026-08-05 is a Wednesday
    expect(startOfWeek(new Date(2026, 7, 5)).getDate()).toBe(3); // Monday the 3rd
    // and a Sunday belongs to the week that has just ended, not the one about to start
    expect(startOfWeek(new Date(2026, 7, 9)).getDate()).toBe(3);
    expect(startOfWeek(new Date(2026, 7, 10)).getDate()).toBe(10); // Monday itself
  });

  it("asks for exactly the days each view draws", () => {
    expect(windowFor("day", new Date(2026, 7, 5)).days).toHaveLength(1);
    expect(windowFor("week", new Date(2026, 7, 5)).days).toHaveLength(7);
    // the month grid is 6 full weeks, so its leading and trailing cells are real days
    const month = windowFor("month", new Date(2026, 7, 5));
    expect(month.days).toHaveLength(42);
    expect(month.from).toBe("2026-07-27"); // the Monday before 1 August
  });

  it("draws every hour at the same height, whatever day it is", () => {
    /**
     * The bug this pins: the grid used to stretch to fit whatever was loaded, so Thursday started
     * at 03:00 and Friday at 08:00 — the same hour sat at a different height on each, and one late
     * meeting pushed everything else off the screen (user, 2026-08-06). The day is now fixed, so
     * a position depends only on the time.
     */
    const noon = placeInGrid(localAt(12), 60);
    expect(noon.topPct).toBeCloseTo((12 / 24) * 100, 5);
    expect(noon.heightPct).toBeCloseTo((60 / 1440) * 100, 5);

    // an early meeting is at its real position, not pinned to an edge with an arrow
    const early = placeInGrid(localAt(3), 60);
    expect(early.topPct).toBeCloseTo((3 / 24) * 100, 5);
    expect(early.clippedStart).toBe(false);

    // and a late one likewise
    const late = placeInGrid(localAt(23), 30);
    expect(late.topPct).toBeCloseTo((23 / 24) * 100, 5);
    expect(late.topPct + late.heightPct).toBeLessThanOrEqual(100.001);
  });

  it("stops a meeting running past midnight at the end of its own day", () => {
    const crosser = placeInGrid(localAt(23, 30), 120);
    expect(crosser.clippedEnd).toBe(true);
    expect(crosser.topPct + crosser.heightPct).toBeLessThanOrEqual(100.001);
  });

  it("gives a short meeting a readable box, and marks it compact", () => {
    // 15 minutes is 1% of a full day — a few pixels, which cannot hold a line of text
    const quick = placeInGrid(localAt(10), 15);
    expect(quick.compact).toBe(true);
    expect(quick.heightPct).toBeGreaterThan((15 / 1440) * 100);
    // and it still never leaves the grid
    expect(quick.topPct + quick.heightPct).toBeLessThanOrEqual(100.001);

    const hour = placeInGrid(localAt(10), 60);
    expect(hour.compact).toBe(false);
    expect(hour.heightPct).toBeCloseTo((60 / 1440) * 100, 5);
  });

  it("measures a box by the minimum when the meeting is shorter than it", () => {
    const start = localAt(13, 15);
    expect(drawnEndMs(start, 15) - new Date(start).getTime()).toBe(MIN_BOX_MINUTES * 60_000);
    expect(drawnEndMs(start, 90) - new Date(start).getTime()).toBe(90 * 60_000);
  });

  it("gives a lone meeting the full width", () => {
    const [only] = columnsFor([m(localAt(10), 60)]);
    expect(only).toMatchObject({ column: 0, columns: 1 });
  });

  it("puts overlapping meetings in separate columns — the clash must stay visible", () => {
    const laid = columnsFor([
      m(localAt(10), 60, "a"),
      m(localAt(10, 30), 60, "b"),
    ]);
    expect(laid.map((l) => l.columns)).toEqual([2, 2]);
    expect(laid.map((l) => l.column).sort()).toEqual([0, 1]);
  });

  it("keeps back-to-back meetings full width — they never overlap", () => {
    const laid = columnsFor([
      m(localAt(10), 60, "a"),
      m(localAt(11), 60, "b"),
    ]);
    expect(laid.every((l) => l.columns === 1)).toBe(true);
  });

  it("separates short back-to-back meetings — their BOXES overlap even though their times do not", () => {
    // The bug this covers: a 15-minute minimum consultation at 13:15 and another at 13:30. The
    // times are adjacent, but both are drawn MIN_BOX_MINUTES tall, so laying out on the true
    // duration gave each the full width and the first box swallowed the second (user, 2026-08-26).
    const laid = columnsFor([
      m(localAt(13, 15), 15, "a"),
      m(localAt(13, 30), 15, "b"),
    ]);
    expect(laid.map((l) => l.columns)).toEqual([2, 2]);
    expect(laid.map((l) => l.column).sort()).toEqual([0, 1]);
  });

  it("still gives short meetings the full width once they are far enough apart", () => {
    // 13:15 + 34 minutes of box ends at 13:49, so 14:00 is clear and nothing has to move aside
    const laid = columnsFor([
      m(localAt(13, 15), 15, "a"),
      m(localAt(14), 15, "b"),
    ]);
    expect(laid.every((l) => l.columns === 1)).toBe(true);
  });

  it("lays out long meetings on their real length, not the minimum box", () => {
    // the floor must not widen a cluster that genuinely has room: 10:00–11:00 then 11:00–12:00
    const laid = columnsFor([
      m(localAt(10), 60, "a"),
      m(localAt(11), 60, "b"),
    ]);
    expect(laid.every((l) => l.columns === 1)).toBe(true);
  });

  it("reuses a column once its meeting has finished", () => {
    // a: 10–12 · b: 10–11 · c: 11–12 — c can sit in b's lane, so two columns suffice
    const laid = columnsFor([
      m(localAt(10), 120, "a"),
      m(localAt(10), 60, "b"),
      m(localAt(11), 60, "c"),
    ]);
    expect(new Set(laid.map((l) => l.columns))).toEqual(new Set([2]));
    const byId = Object.fromEntries(laid.map((l) => [l.item.id, l.column]));
    expect(byId.b).not.toBe(byId.a);
    expect(byId.c).toBe(byId.b);
  });
});
