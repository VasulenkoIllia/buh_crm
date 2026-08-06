import { describe, expect, it } from "vitest";
import { overlapping, spanEndMs, spansOverlap } from "./meetings.js";

/**
 * The boundary is the whole point of this file. Overlap checks classically break in exactly two
 * places — the touching pair reported as a clash, and the one-minute nick reported as clear — so
 * both are pinned first, before anything convenient.
 */

const at = (hhmm: string, durationMinutes: number) => ({
  startAt: `2026-08-10T${hhmm}:00.000Z`,
  durationMinutes,
});

describe("meeting overlap", () => {
  it("back-to-back meetings do not collide", () => {
    // 10:00–11:00 then 11:00–12:00 — the first has ended at the instant the second starts
    expect(spansOverlap(at("10:00", 60), at("11:00", 60))).toBe(false);
    expect(spansOverlap(at("11:00", 60), at("10:00", 60))).toBe(false); // and the other way round
  });

  it("one minute of shared time is a collision", () => {
    expect(spansOverlap(at("10:00", 60), at("10:59", 31))).toBe(true);
    expect(spansOverlap(at("10:59", 31), at("10:00", 60))).toBe(true);
  });

  it("a meeting wholly inside another collides", () => {
    expect(spansOverlap(at("10:00", 120), at("10:30", 15))).toBe(true);
    expect(spansOverlap(at("10:30", 15), at("10:00", 120))).toBe(true);
  });

  it("identical slots collide", () => {
    expect(spansOverlap(at("09:00", 30), at("09:00", 30))).toBe(true);
  });

  it("a gap of a single minute is clear", () => {
    expect(spansOverlap(at("10:00", 60), at("11:01", 30))).toBe(false);
  });

  it("a zero-length span occupies nothing and so collides with nothing", () => {
    // the schema forbids it; a half-edited form can still hold it, and "touches everything,
    // overlaps nothing" is the answer that keeps the live warning quiet until there is a meeting
    expect(spansOverlap(at("10:00", 0), at("10:00", 60))).toBe(false);
    expect(spansOverlap(at("10:30", 0), at("10:00", 60))).toBe(false);
  });

  it("accepts Date and string alike, and reads the end exclusively", () => {
    const span = { startAt: new Date("2026-08-10T10:00:00.000Z"), durationMinutes: 45 };
    expect(spanEndMs(span)).toBe(new Date("2026-08-10T10:45:00.000Z").getTime());
    expect(spansOverlap(span, at("10:45", 15))).toBe(false);
    expect(spansOverlap(span, at("10:44", 15))).toBe(true);
  });

  it("different days never collide", () => {
    expect(
      spansOverlap(at("23:30", 60), { startAt: "2026-08-11T10:00:00.000Z", durationMinutes: 60 }),
    ).toBe(false);
  });

  it("a meeting running past midnight collides with the next morning", () => {
    expect(
      spansOverlap(at("23:30", 90), { startAt: "2026-08-11T00:30:00.000Z", durationMinutes: 30 }),
    ).toBe(true);
  });

  it("overlapping() keeps the clashes, in the order given", () => {
    const others = [
      { id: "a", ...at("09:00", 60) },
      { id: "b", ...at("10:00", 60) }, // touches, clear
      { id: "c", ...at("10:30", 60) },
      { id: "d", ...at("12:00", 60) },
    ];
    expect(overlapping(at("10:15", 30), others).map((o) => o.id)).toEqual(["b", "c"]);
    expect(overlapping(at("08:00", 30), others)).toEqual([]);
  });
});
