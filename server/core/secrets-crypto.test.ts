import { describe, expect, it } from "vitest";
import { open, seal, secretsConfigured } from "./secrets-crypto.js";

// These run only when the dev environment has a key; without one the vault is meant to be off.
describe.runIf(secretsConfigured())("secrets crypto", () => {
  it("round-trips a value, including non-ASCII", () => {
    const plain = "кабінет платника: 1234567890 / пароль: Ы!ц№$ 🔐";
    expect(open(seal(plain))).toBe(plain);
  });

  it("uses a fresh IV every time, so the same value never looks the same twice", () => {
    const a = seal("same");
    const b = seal("same");
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it("refuses a tampered ciphertext instead of returning garbage", () => {
    const sealed = seal("do not touch");
    sealed.ciphertext[0] ^= 0xff; // flip a bit
    expect(() => open(sealed)).toThrow();
  });

  it("refuses a tampered auth tag", () => {
    const sealed = seal("do not touch");
    sealed.authTag[0] ^= 0xff;
    expect(() => open(sealed)).toThrow();
  });
});
