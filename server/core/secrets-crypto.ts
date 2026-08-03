/**
 * Encryption for client secrets — tax-portal logins, client-bank credentials, КЕП passwords.
 *
 * AES-256-GCM with a key from `SECRETS_KEY` (decision 2026-08-01, "key model A"). The threat this
 * actually defends against is a leaked database dump: `scripts/deploy.sh` writes one to the
 * operator's home directory on every deploy, and a plaintext column would put every client's
 * credentials into every one of those files. It does NOT defend against root on the box, where the
 * dump and the key sit together — which is why `.env` must never share a backup with the dump
 * (see docs/deployment.md).
 *
 * GCM, not CBC: it authenticates as well as encrypts, so a tampered ciphertext fails loudly at
 * decrypt instead of returning plausible garbage. A fresh 12-byte IV per encryption — reusing one
 * with the same key is the single mistake that breaks GCM completely.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/** Bumped only if the key is ever rotated; stored per row so old rows stay readable. */
export const CURRENT_KEY_VERSION = 1;

const IV_BYTES = 12; // GCM's native size — anything else forces a slower, non-standard path
const KEY_BYTES = 32; // AES-256

/**
 * `Uint8Array`, not `Buffer`: that is what Prisma hands back for a `Bytes` column, and Buffer is a
 * Uint8Array anyway — typing it this way lets a row go straight into `open()` without a cast.
 */
export interface SealedSecret {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
}

let cachedKey: Buffer | null = null;

/** The configured key, or null when the firm hasn't set one up yet. */
function key(): Buffer | null {
  if (cachedKey) return cachedKey;
  if (!config.SECRETS_KEY) return null;
  const raw = Buffer.from(config.SECRETS_KEY, "base64");
  if (raw.length !== KEY_BYTES) {
    // a short key is worse than none: it would "work" and quietly weaken everything stored
    throw new Error(
      `SECRETS_KEY must be ${KEY_BYTES} bytes base64 (got ${raw.length}) — generate with: openssl rand -base64 32`,
    );
  }
  cachedKey = raw;
  return cachedKey;
}

/** Is the vault usable at all? The API answers 503 rather than pretending when this is false. */
export const secretsConfigured = (): boolean => key() !== null;

export function seal(plaintext: string): SealedSecret {
  const k = key();
  if (!k) throw new Error("SECRETS_KEY is not configured");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: CURRENT_KEY_VERSION };
}

export function open(sealed: SealedSecret): string {
  const k = key();
  if (!k) throw new Error("SECRETS_KEY is not configured");
  const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(sealed.iv));
  decipher.setAuthTag(Buffer.from(sealed.authTag));
  // throws if the ciphertext or the tag was tampered with — which is the point of GCM
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext)), decipher.final()]).toString(
    "utf8",
  );
}

/** Constant-time compare, for anything that comes from a request and gates access. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
