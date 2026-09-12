import { describe, expect, it } from "vitest";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  isRecoveryCodeShape,
  matchRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "./recovery-codes.js";

describe("recovery codes (two-factor.md §6.2)", () => {
  it("issues ten distinct codes with nothing in them to misread", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[2-9a-hjkmnp-z]{5}-[2-9a-hjkmnp-z]{5}$/);
      expect(code).not.toMatch(/[01ilo]/);
    }
  });

  it("reads a code however it was copied out — case, dash, spaces", () => {
    expect(normalizeRecoveryCode(" AB2CD-EF3GH ")).toBe("ab2cdef3gh");
    expect(isRecoveryCodeShape("AB2CD EF3GH")).toBe(true);
    // a six-digit code from the app is never mistaken for one
    expect(isRecoveryCodeShape("123456")).toBe(false);
    // nor is something the alphabet cannot contain
    expect(isRecoveryCodeShape("ab1cd-ef0gh")).toBe(false);
  });

  it("finds the matching code among the unused ones, and nothing for a wrong one", async () => {
    const [first, second] = generateRecoveryCodes(2);
    const candidates = [
      { id: "a", codeHash: await hashRecoveryCode(first) },
      { id: "b", codeHash: await hashRecoveryCode(second) },
    ];
    expect(await matchRecoveryCode(second.toUpperCase().replace("-", ""), candidates)).toBe(
      "b",
    );
    expect(await matchRecoveryCode(first, candidates)).toBe("a");
    expect(await matchRecoveryCode("zzzzz-zzzzz", candidates)).toBeNull();
    expect(await matchRecoveryCode("123456", candidates)).toBeNull();
  });
});
