import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "./db.js";
import {
  claimAlert,
  delayAfter,
  FREE_FAILURES,
  MAX_DELAY_SECONDS,
  recordFailure,
} from "./sign-in-throttle.js";

describe("the sign-in delay (two-factor.md §9)", () => {
  it("costs nothing for the first few failures — a mistyped password never waits", () => {
    for (let n = 0; n <= FREE_FAILURES; n++) expect(delayAfter(n)).toBe(0);
  });

  it("doubles from there and stops at a ceiling of seconds, never minutes", () => {
    expect([5, 6, 7, 8, 9, 10, 500].map(delayAfter)).toEqual([2, 4, 8, 16, 32, 60, 60]);
    expect(MAX_DELAY_SECONDS).toBe(60);
  });
});

/**
 * The two races the counters exist to win (security review, 2026-09-12): failures arriving together
 * must each count — including the ones that create the row — and a run crossing the threshold on
 * several requests at once must earn exactly one letter.
 */
describe("the counters under concurrency", () => {
  const KEY = "test:concurrency@throttle.local";

  afterAll(async () => {
    await prisma.signInThrottle.deleteMany({ where: { key: KEY } });
  });

  it("counts ten simultaneous failures as ten, starting from a key that did not exist", async () => {
    await prisma.signInThrottle.deleteMany({ where: { key: KEY } });
    await Promise.all(Array.from({ length: 10 }, () => recordFailure([KEY])));
    const row = await prisma.signInThrottle.findUniqueOrThrow({ where: { key: KEY } });
    expect(row.failures).toBe(10);
  });

  it("lets exactly one of several simultaneous claims send the letter", async () => {
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claimAlert(KEY, 12 * 60 * 60 * 1000)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});
