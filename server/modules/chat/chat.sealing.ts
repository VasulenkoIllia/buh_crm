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

/**
 * The text, or `null` when there is none: a deleted message, a notice, a message of files only.
 *
 * **A row that will not open is one row, not the screen.** `open()` throws when the tag does not
 * verify — which is the point of GCM — and every caller here is in a loop over somebody's whole
 * chat list, a page of history or a search. Unguarded, a single damaged row (a partial restore, a
 * key rotated without its `keyVersion`, a truncated write) took away ALL of a person's chats, not
 * the one that was hurt (audit, 2026-09-20). It is logged, loudly and without the ciphertext, and
 * the reader sees an unreadable line beside the rest of their conversation.
 */
export function openText(row: SealedColumns): string | null {
  if (!row.ciphertext || !row.iv || !row.authTag) return null;
  try {
    return open({
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
      keyVersion: row.keyVersion,
    });
  } catch (err) {
    console.error(
      `chat: a sealed value (key version ${row.keyVersion}) would not open: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return UNREADABLE;
  }
}

/** What a reader is shown in place of a row that would not open. */
export const UNREADABLE = "⚠︎";

export function sealGroup(info: GroupInfo): Sealed {
  return sealText(JSON.stringify(info));
}

export function openGroup(row: SealedColumns): GroupInfo | null {
  const raw = openText(row);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as GroupInfo;
  } catch {
    // an unreadable or malformed group keeps its screen: the list names it by what it is
    return { title: UNREADABLE, description: null };
  }
}

export function sealOptions(options: readonly string[]): Sealed {
  return sealText(JSON.stringify(options));
}

export function openOptions(row: SealedColumns): string[] {
  const raw = openText(row);
  if (raw === null) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}
