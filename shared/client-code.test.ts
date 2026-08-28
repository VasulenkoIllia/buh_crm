import { describe, expect, it } from "vitest";
import { clientCode, codeInSearch } from "./schema/client.js";

/**
 * The two halves of one promise: what a client code LOOKS like, and what a person can TYPE to find
 * it again. They live in one module so they cannot drift, and this file is what says so.
 */

describe("clientCode", () => {
  it("pads to three so a column of codes lines up", () => {
    expect(clientCode(1)).toBe("C-001");
    expect(clientCode(42)).toBe("C-042");
    expect(clientCode(177)).toBe("C-177");
  });

  it("lets a wider number simply be wider — the padding is a floor, not a limit", () => {
    expect(clientCode(1000)).toBe("C-1000");
    expect(clientCode(123456)).toBe("C-123456");
  });
});

describe("codeInSearch", () => {
  it("accepts what people type after reading a code off a message", () => {
    for (const q of ["C-042", "c-042", "c042", "C042", "042", "42", " C-042 ", "C 042"]) {
      expect(codeInSearch(q)).toBe(42);
    }
  });

  it("round-trips whatever clientCode produced", () => {
    for (const n of [1, 42, 177, 1000, 123456]) {
      expect(codeInSearch(clientCode(n))).toBe(n);
    }
  });

  it("returns null for anything that is not a code, so the clause is left out entirely", () => {
    // a search must never be NARROWED by a condition that cannot match
    for (const q of ["Ivan", "ivan@example.com", "+1 646 555 0110", "", "  ", "C-", "abc", "4a2"]) {
      expect(codeInSearch(q)).toBeNull();
    }
  });

  it("refuses zero and its paddings — codes start at 1", () => {
    expect(codeInSearch("0")).toBeNull();
    expect(codeInSearch("C-000")).toBeNull();
  });

  it("does not read a long digit run as a code", () => {
    // a phone number typed in full is not a client code, however many digits it has
    expect(codeInSearch("16465550110123")).toBeNull();
  });
});
