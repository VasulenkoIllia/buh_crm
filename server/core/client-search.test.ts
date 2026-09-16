import { describe, expect, it } from "vitest";
import { MAX_QUERY_WORDS, clientText, codeOf, wordsOf } from "./client-search.js";

/**
 * The rule two screens share (files.md §13, secrets.md §10). It was two copies for a day; these are
 * the cases that made it what it is, and they now hold both modules to the same answer.
 */
describe("how a person names a client", () => {
  it("reads a code however it is written, and refuses what is not one", () => {
    for (const typed of ["142", "#142", "C-142", "c142", "C–142", "C 142", " 142 "]) {
      expect(codeOf(typed), typed).toBe(142);
    }
    expect(codeOf("Petrenko")).toBeNull();
    // a dash belongs to a code only after the C
    expect(codeOf("-142")).toBeNull();
    // longer than the code's 32-bit column: a pasted phone number is not a code, and must not throw
    expect(codeOf("5551234567")).toBeNull();
    expect(codeOf("0")).toBeNull();
  });

  it("takes every word on its own, and no more than eight", () => {
    expect(wordsOf("  Olena   Petrenko ")).toEqual(["Olena", "Petrenko"]);
    expect(wordsOf("a b c d e f g h i j")).toHaveLength(MAX_QUERY_WORDS);
    expect(wordsOf("   ")).toEqual([]);
  });

  it("asks for every word, in any order, or for the whole query as a code", () => {
    // one clause per word, ANDed: which field holds which word does not matter, so a full name
    // finds the client whichever way round it is typed
    const byName = clientText("Olena Petrenko").OR as { AND?: unknown[]; code?: number }[];
    expect(byName).toHaveLength(1);
    expect(byName[0].AND).toHaveLength(2);

    const byCode = clientText("#142").OR as { AND?: unknown[]; code?: number }[];
    expect(byCode.some((clause) => clause.code === 142)).toBe(true);
  });
});
