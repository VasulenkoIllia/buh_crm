import { beforeAll, describe, expect, it } from "vitest";
import { firmWallClockToInstant, setFirmTimezone } from "@/shared/lib/tz";
import { columnsFor, placeInGrid, startOfWeek, windowFor } from "./grid.js";

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
    const noon = placeInGrid(localAt(14), 60);
    expect(noon.clippedStart).toBe(false);
    expect(noon.topPct).toBeGreaterThan(0);
    expect(noon.heightPct).toBeCloseTo((60 / 720) * 100, 5);
  });

  it("clamps an event that runs past the end of the grid instead of drawing outside it", () => {
    const late = placeInGrid(localAt(19), 240); // 19:00 + 4h, grid ends at 20:00
    expect(late.topPct + late.heightPct).toBeLessThanOrEqual(100.001);
    expect(late.clippedEnd).toBe(true);
  });

  it("clamps an event starting after the grid has ended", () => {
    const night = placeInGrid(localAt(22), 60);
    expect(night.topPct).toBeLessThanOrEqual(100);
    expect(night.topPct + night.heightPct).toBeLessThanOrEqual(100.001);
  });

  it("flags an event starting before the drawn day rather than moving it", () => {
    expect(placeInGrid(localAt(6), 60).clippedStart).toBe(true);
  });

  it("gives a short meeting a readable box, and marks it compact", () => {
    // 15 minutes is 2% of a 12-hour grid — about 13px, which cannot hold a line of text
    const quick = placeInGrid(localAt(10), 15);
    expect(quick.compact).toBe(true);
    expect(quick.heightPct).toBeGreaterThan((15 / 720) * 100);
    // and it still never leaves the grid
    expect(quick.topPct + quick.heightPct).toBeLessThanOrEqual(100.001);

    const hour = placeInGrid(localAt(10), 60);
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
