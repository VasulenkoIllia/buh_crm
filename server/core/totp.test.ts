import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  formatSecret,
  generateTotpSecret,
  hotp,
  matchStep,
  otpauthUri,
  stepAt,
} from "./totp.js";

/** The seed both RFCs use for their vectors: the ASCII bytes "12345678901234567890". */
const RFC_KEY = Buffer.from("12345678901234567890", "ascii");

describe("the codes themselves — pinned to the RFCs' own vectors", () => {
  it("computes RFC 4226's HOTP values for counters 0–9", () => {
    expect(Array.from({ length: 10 }, (_, counter) => hotp(RFC_KEY, counter))).toEqual([
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ]);
  });

  it("computes RFC 6238's TOTP values (SHA-1, eight digits) at the appendix's instants", () => {
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, code] of vectors) {
      expect(hotp(RFC_KEY, stepAt(seconds * 1000), 8), `T=${seconds}`).toBe(code);
    }
  });

  it("round-trips base32, and reads a key typed with spaces, dashes and lower case", () => {
    expect(base32Encode(RFC_KEY)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    const secret = generateTotpSecret();
    const encoded = base32Encode(secret);
    expect(base32Decode(encoded).equals(secret)).toBe(true);
    expect(base32Decode(formatSecret(encoded).toLowerCase().replace(/ /g, "-"))).toEqual(
      secret,
    );
    expect(() => base32Decode("NOT*BASE32")).toThrow();
  });
});

describe("the rules that make a code safe to accept (two-factor.md §4)", () => {
  // a fixed key and instant, so no two steps in reach share a code and the boundary is exact
  const now = 1_234_567_890_000;
  const current = stepAt(now);
  const at = (step: number) => hotp(RFC_KEY, step);

  it("accepts this step and one either side — and refuses two away (the drift window)", () => {
    expect(matchStep(RFC_KEY, at(current), now, null)).toBe(current);
    expect(matchStep(RFC_KEY, at(current - 1), now, null)).toBe(current - 1);
    expect(matchStep(RFC_KEY, at(current + 1), now, null)).toBe(current + 1);
    expect(matchStep(RFC_KEY, at(current - 2), now, null)).toBeNull();
    expect(matchStep(RFC_KEY, at(current + 2), now, null)).toBeNull();
  });

  it("refuses a code already used, and an older one once a newer was used (single use)", () => {
    expect(matchStep(RFC_KEY, at(current), now, current)).toBeNull();
    expect(matchStep(RFC_KEY, at(current - 1), now, current)).toBeNull();
    expect(matchStep(RFC_KEY, at(current + 1), now, current)).toBe(current + 1);
  });

  it("reads a code typed with a space, and refuses anything that is not six digits", () => {
    const code = at(current);
    expect(matchStep(RFC_KEY, `${code.slice(0, 3)} ${code.slice(3)}`, now, null)).toBe(current);
    for (const bad of ["", "12345", "1234567", "abcdef", `${code}0`]) {
      expect(matchStep(RFC_KEY, bad, now, null), bad).toBeNull();
    }
  });
});

describe("the URI an authenticator scans", () => {
  it("names the firm and the person, and carries the key and the parameters", () => {
    const uri = otpauthUri({
      issuer: "ILLION Tax & Accounting",
      account: "olena@firm.test",
      secret: "GEZDGNBVGY3TQOJQ",
    });
    expect(
      uri.startsWith("otpauth://totp/ILLION%20Tax%20%26%20Accounting:olena%40firm.test?"),
    ).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get("secret")).toBe("GEZDGNBVGY3TQOJQ");
    expect(params.get("issuer")).toBe("ILLION Tax & Accounting");
    expect(params.get("digits")).toBe("6");
    expect(params.get("period")).toBe("30");
  });
});
