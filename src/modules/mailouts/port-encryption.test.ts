import { describe, expect, it } from "vitest";
import { encryptionFor, encryptionLabel, secureFor } from "./port-encryption";

describe("what a port says about encryption", () => {
  it("answers for the four ports mail actually uses", () => {
    expect(encryptionFor(465)).toBe("tls");
    expect(encryptionFor(993)).toBe("tls");
    expect(encryptionFor(587)).toBe("starttls");
    expect(encryptionFor(143)).toBe("starttls");
  });

  it("reads the string a text input gives it", () => {
    expect(encryptionFor("587")).toBe("starttls");
    expect(encryptionFor("993")).toBe("tls");
  });

  /** An unusual port is exactly when to ask rather than guess. */
  it("says nothing about a port it does not know, including an empty one", () => {
    for (const p of [2525, 1025, 0, "", null, undefined, "abc"]) {
      expect(encryptionFor(p as never), String(p)).toBeNull();
    }
  });

  it("names them the way the field spells them", () => {
    expect(encryptionLabel("tls")).toBe("TLS");
    expect(encryptionLabel("starttls")).toBe("STARTTLS");
  });

  describe("the value the API stores", () => {
    it("lets a known port overrule whatever was ticked before", () => {
      // the trap this removes: 587 left ticked from a 465 the person typed first
      expect(secureFor(587, true)).toBe(false);
      expect(secureFor(465, false)).toBe(true);
      expect(secureFor(993, false)).toBe(true);
      expect(secureFor(143, true)).toBe(false);
    });

    it("keeps the person's own answer on a port nobody can speak for", () => {
      expect(secureFor(2525, true)).toBe(true);
      expect(secureFor(2525, false)).toBe(false);
      expect(secureFor("", true)).toBe(true);
    });
  });
});
