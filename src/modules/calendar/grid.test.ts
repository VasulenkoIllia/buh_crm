import { beforeAll, describe, expect, it } from "vitest";
import {
  firmMinutesOfDay,
  firmWallClockToInstant,
  instantToFirmWallClock,
  setFirmTimezone,
} from "@/shared/lib/tz";
import {
  DEFAULT_END_HOUR,
  DEFAULT_START_HOUR,
  columnsFor,
  dayOfMeeting,
  fmtRange,
  placeInGrid,
  rangeFor,
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
/** the working day the grid falls back to when nothing sits outside it */
const WORKDAY = { startHour: DEFAULT_START_HOUR, endHour: DEFAULT_END_HOUR };

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

  it("places a meeting by its minutes into the drawn range", () => {
    const noon = placeInGrid(localAt(14), 60, WORKDAY);
    expect(noon.clippedStart).toBe(false);
    expect(noon.topPct).toBeGreaterThan(0);
    expect(noon.heightPct).toBeCloseTo((60 / 720) * 100, 5);
  });

  // These two pin the CLAMP, which still matters: the range is computed from the meetings the
  // calendar loaded, and a caller can always hand in a narrower one.
  it("clamps an event that runs past the end of the grid instead of drawing outside it", () => {
    const late = placeInGrid(localAt(19), 240, WORKDAY); // 19:00 + 4h, grid ends at 20:00
    expect(late.topPct + late.heightPct).toBeLessThanOrEqual(100.001);
    expect(late.clippedEnd).toBe(true);
  });

  it("clamps an event starting after the grid has ended", () => {
    const night = placeInGrid(localAt(22), 60, WORKDAY);
    expect(night.topPct).toBeLessThanOrEqual(100);
    expect(night.topPct + night.heightPct).toBeLessThanOrEqual(100.001);
  });

  it("flags an event starting before the drawn day rather than moving it", () => {
    expect(placeInGrid(localAt(6), 60, WORKDAY).clippedStart).toBe(true);
  });

  it("stretches the drawn hours to fit whatever is in the window", () => {
    // the working day, when everything is inside it
    expect(rangeFor([{ startAt: localAt(10), durationMinutes: 60 }])).toEqual(WORKDAY);

    // an early call widens the top rather than being pinned to the 08:00 line with an arrow —
    // the label used to read 03:00 while the box sat against 08:00, so position contradicted text
    expect(rangeFor([{ startAt: localAt(3), durationMinutes: 60 }]).startHour).toBe(3);

    // a late one widens the bottom
    expect(rangeFor([{ startAt: localAt(21), durationMinutes: 90 }]).endHour).toBe(23);

    // and an event running past midnight stops at the end of its own day
    expect(rangeFor([{ startAt: localAt(23), durationMinutes: 120 }]).endHour).toBe(24);

    // widened, the early meeting is drawn where it actually is, with no clipping marker
    const wide = rangeFor([{ startAt: localAt(3), durationMinutes: 60 }]);
    const pos = placeInGrid(localAt(3), 60, wide);
    expect(pos.topPct).toBe(0);
    expect(pos.clippedStart).toBe(false);
  });

  it("gives a short meeting a readable box, and marks it compact", () => {
    // 15 minutes is 2% of a 12-hour grid — about 13px, which cannot hold a line of text
    const quick = placeInGrid(localAt(10), 15, WORKDAY);
    expect(quick.compact).toBe(true);
    expect(quick.heightPct).toBeGreaterThan((15 / 720) * 100);
    // and it still never leaves the grid
    expect(quick.topPct + quick.heightPct).toBeLessThanOrEqual(100.001);

    const hour = placeInGrid(localAt(10), 60, WORKDAY);
    expect(hour.compact).toBe(false);
    expect(hour.heightPct).toBeCloseTo((60 / 720) * 100, 5);
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
