import { describe, expect, it } from "vitest";
import { fmtBytes } from "./format";

describe("fmtBytes: a size in the unit that says something", () => {
  it("never shows a small file as 0.0 MB, nor a firm's total in thousands of MB", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(40 * 1024)).toBe("40 KB");
    expect(fmtBytes(25 * 1024 * 1024)).toBe("25.0 MB");
    expect(fmtBytes(3.1 * 1024 ** 3)).toBe("3.1 GB");
  });
});
