import { ImapFlow } from "imapflow";

/**
 * Reading a mailbox back.
 *
 * Sending is only half of a mailbox. Bounces arrive as ordinary mail, to the envelope sender — a
 * mailbox the hosting picks, not necessarily the one that appears in `From:` — so which mailbox
 * holds them is configuration, never an inference.
 *
 * This module is the connection only. What to do with a returned letter lives with the mailouts
 * module; keeping the two apart means the parser can be tested without a server, and the transport
 * can be proven without a parser.
 */
export interface ImapAccount {
  host: string;
  port: number;
  /** true = implicit TLS on 993; false = STARTTLS on 143 */
  secure: boolean;
  user: string | null;
  pass: string | null;
}

/**
 * Which credentials read this mailbox — the decision alone, with no decryption in it.
 *
 * One rule, not a chain: a username of its own comes with a password of its own, and no username
 * means the SMTP pair is reused whole. Mixing the two — this username with that password — is the
 * failure worth designing out, because it authenticates as somebody nobody chose.
 *
 * Pure, and separate from `imapFor`, so the rule can be asserted without a server or a key. The
 * version that lived inline was exercised only by a live connection, which meant a change to it
 * broke nothing in the suite.
 */
export function imapAuth(account: { imapUser: string | null; smtpUser: string | null }): {
  user: string | null;
  ownPassword: boolean;
} {
  const own = account.imapUser?.trim();
  return own
    ? { user: own, ownPassword: true }
    : { user: account.smtpUser, ownPassword: false };
}

/**
 * Open the mailbox, authenticate, and report what is in it — without reading or changing anything.
 *
 * `INBOX` is opened read-ONLY on purpose. This mailbox belongs to a person: marking a message seen
 * would hide a bounce from them, and their reading it must not hide one from us. Nothing here may
 * move, delete or flag a message, and the read-only lock is the guarantee rather than a promise in
 * a comment.
 */
export async function verifyImap(
  account: ImapAccount,
): Promise<{ mailbox: string; messages: number; uidValidity: string }> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: account.user ? { user: account.user, pass: account.pass ?? "" } : undefined,
    // The library logs every command at info level; a mailbox check does not warrant that in the
    // server log, and the credentials travel through those lines.
    logger: false,
    // Fail fast rather than hanging a request on an unreachable host, matching the SMTP timeouts.
    socketTimeout: 20_000,
    greetingTimeout: 10_000,
    connectionTimeout: 10_000,
  });

  // The connect is INSIDE the try: a handshake that fails partway can still leave a socket open,
  // and a mailbox check that leaks one per attempt is a check nobody can run twice.
  try {
    await client.connect();
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    return {
      mailbox: box.path,
      messages: box.exists,
      // A string, not a number: UIDVALIDITY is a 32-bit unsigned value that arrives as a BigInt,
      // and `JSON.stringify` throws on those rather than rounding, which would be worse.
      uidValidity: String(box.uidValidity),
    };
  } finally {
    // `logout` speaks the protocol properly; `close` drops the socket. A server that is told
    // goodbye does not count the connection as an abandoned session against the account.
    await client.logout().catch(() => client.close());
  }
}

/** One message as the reader sees it: enough to parse, and the bookmark to move past it. */
export interface RawMessage {
  uid: number;
  source: string;
}

/**
 * Read the messages that arrived since last time, oldest first.
 *
 * READ-ONLY throughout, and that is the whole design constraint: this mailbox belongs to a person.
 * Marking a message seen would hide a bounce from them; their reading it must not hide one from
 * us. So nothing is flagged, moved or deleted, and progress is tracked by UID on our side instead.
 *
 * `uidValidity` is the mailbox's own generation counter. When it changes the server has reissued
 * every UID, so the caller's bookmark means nothing any more and the scan must start over — which
 * is why it comes back with the messages rather than being assumed.
 */
export async function fetchSince(
  account: ImapAccount,
  sinceUid: number | null,
  limit = 200,
): Promise<{ uidValidity: string; messages: RawMessage[] }> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: account.user ? { user: account.user, pass: account.pass ?? "" } : undefined,
    logger: false,
    socketTimeout: 30_000,
    greetingTimeout: 10_000,
    connectionTimeout: 10_000,
  });

  try {
    await client.connect();
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    const uidValidity = String(box.uidValidity);
    // A reissued mailbox invalidates the bookmark completely; anything else resumes past it.
    const from = sinceUid && uidValidity === String(box.uidValidity) ? sinceUid + 1 : 1;

    const messages: RawMessage[] = [];
    if (box.exists > 0) {
      for await (const msg of client.fetch(
        `${from}:*`,
        { uid: true, source: true },
        { uid: true },
      )) {
        // `${n}:*` never returns fewer than one message: a server with nothing newer answers with
        // the last one instead of an empty set. Filtering by UID is what makes the range honest.
        if (sinceUid !== null && msg.uid <= sinceUid) continue;
        // A message can come back without its body if it was deleted between the search and the
        // fetch. Skipping it rather than throwing keeps one vanished message from stalling a sweep
        // — the bookmark still moves past it, so it is not retried forever.
        if (!msg.source) continue;
        messages.push({ uid: msg.uid, source: msg.source.toString("utf8") });
        if (messages.length >= limit) break;
      }
    }
    messages.sort((a, b) => a.uid - b.uid);
    return { uidValidity, messages };
  } finally {
    await client.logout().catch(() => client.close());
  }
}
