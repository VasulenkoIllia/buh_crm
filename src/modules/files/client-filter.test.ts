import { describe, expect, it } from "vitest";
import { matchesClient } from "./client-filter";

const petrenko = { label: "Olena Petrenko", code: 142 };

describe("finding a client in the list (files.md §13)", () => {
  it("matches any part of the name, whatever the case", () => {
    expect(matchesClient(petrenko, "petr")).toBe(true);
    expect(matchesClient(petrenko, "OLENA")).toBe(true);
    expect(matchesClient(petrenko, "Kovalenko")).toBe(false);
  });

  it("matches the code however it is typed, its start being enough", () => {
    for (const typed of ["142", "#142", "C-142", "c142", "C–142", "14", "#0142"]) {
      expect(matchesClient(petrenko, typed)).toBe(true);
    }
    expect(matchesClient(petrenko, "143")).toBe(false);
    expect(matchesClient(petrenko, "#42")).toBe(false);
    // a dash is part of a code only after C
    expect(matchesClient(petrenko, "-142")).toBe(false);
  });

  it("takes each word on its own, in any order", () => {
    expect(matchesClient(petrenko, "Petrenko Olena")).toBe(true);
    expect(matchesClient(petrenko, "olena  petr")).toBe(true);
    expect(matchesClient(petrenko, "Petrenko 142")).toBe(true);
    expect(matchesClient(petrenko, "C 142")).toBe(true);
    expect(matchesClient(petrenko, "Olena Kovalenko")).toBe(false);
  });

  it("keeps every client while nothing is typed", () => {
    expect(matchesClient(petrenko, "  ")).toBe(true);
  });
});
