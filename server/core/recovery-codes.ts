/**
 * **Recovery codes — the way back when the phone is gone** (docs/modules/two-factor.md §6.2, §7).
 *
 * Ten, single-use, argon2-hashed like passwords: they are only ever compared, so losing the ability
 * to read them back is the point. Knows nothing about users or storage (§4.2).
 *
 * Ten characters from an alphabet with nothing to misread (no 0/o, 1/l/i) — about 49 bits each,
 * which is far beyond an online guess (five tries per password, then the throttle) and, behind
 * argon2, beyond an offline one too. Shown as `abcde-fghjk`; accepted with or without the dash, in
 * any case, with spaces — however somebody copies them out of a password manager.
 */
import { randomInt } from "node:crypto";
import argon2 from "argon2";

export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const LENGTH = 10;

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    let code = "";
    for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Is this what a recovery code looks like, rather than a six-digit code from the app? */
export function isRecoveryCodeShape(input: string): boolean {
  const code = normalizeRecoveryCode(input);
  return code.length === LENGTH && [...code].every((ch) => ALPHABET.includes(ch));
}

export function hashRecoveryCode(code: string): Promise<string> {
  return argon2.hash(normalizeRecoveryCode(code));
}

/**
 * Which of these unused codes the input is, or null.
 *
 * Every candidate is checked, in parallel, whatever matches first — so the time taken says nothing
 * about which code, or how many remain. The caller spends the match with a conditional write; this
 * only says which one it would be.
 */
export async function matchRecoveryCode(
  input: string,
  candidates: Array<{ id: string; codeHash: string }>,
): Promise<string | null> {
  if (!isRecoveryCodeShape(input)) return null;
  const code = normalizeRecoveryCode(input);
  const verdicts = await Promise.all(
    candidates.map(async (candidate) =>
      (await argon2.verify(candidate.codeHash, code).catch(() => false)) ? candidate.id : null,
    ),
  );
  return verdicts.find((id) => id !== null) ?? null;
}
