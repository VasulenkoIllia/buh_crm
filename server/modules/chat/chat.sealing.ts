import { open, seal } from "../../core/secrets-crypto.js";

/**
 * **What the chat keeps sealed, and how it reads it back** (chat.md §9): a message's text (a poll's
 * question), a poll's options, a group's title and description. AES-256-GCM through the vault's
 * helper, with a `keyVersion` per row, so a key rotation leaves old rows readable.
 *
 * The columns are the vault's names (`ciphertext`, `iv`, `authTag`, `keyVersion`), so a row goes
 * in and out of these as it is. A value is whole or absent: the migration's CHECKs refuse a row
 * that has one part without the others.
 */

export interface SealedColumns {
  ciphertext: Uint8Array | null;
  iv: Uint8Array | null;
  authTag: Uint8Array | null;
  keyVersion: number;
}

/** Ready to write: a `Bytes` column takes a buffer of its own, as the vault's repository hands it. */
export interface Sealed {
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
  keyVersion: number;
}

/** A group's words, sealed together: the title every member sees, and an optional description. */
export interface GroupInfo {
  title: string;
  description: string | null;
}

export function sealText(text: string): Sealed {
  const { ciphertext, iv, authTag, keyVersion } = seal(text);
  return {
    ciphertext: Buffer.from(ciphertext),
    iv: Buffer.from(iv),
    authTag: Buffer.from(authTag),
    keyVersion,
  };
}

/** The text, or `null` when there is none: a deleted message, a notice, a message of files only. */
export function openText(row: SealedColumns): string | null {
  if (!row.ciphertext || !row.iv || !row.authTag) return null;
  return open({
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
    keyVersion: row.keyVersion,
  });
}

/** What a delete for everyone writes: the sealed text gone for good, the row kept for its `seq`. */
export const NO_TEXT = { ciphertext: null, iv: null, authTag: null } as const;

export function sealGroup(info: GroupInfo): Sealed {
  return sealText(JSON.stringify(info));
}

export function openGroup(row: SealedColumns): GroupInfo | null {
  const raw = openText(row);
  return raw === null ? null : (JSON.parse(raw) as GroupInfo);
}

export function sealOptions(options: readonly string[]): Sealed {
  return sealText(JSON.stringify(options));
}

export function openOptions(row: SealedColumns): string[] {
  const raw = openText(row);
  return raw === null ? [] : (JSON.parse(raw) as string[]);
}
