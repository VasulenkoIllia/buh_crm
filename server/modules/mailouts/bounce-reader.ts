import { fetchSince } from "../../core/imap.js";
import { explainSendError } from "../../core/send-error.js";
import { bounceHeadline } from "@shared/delivery.js";
import { parseBounce, type Bounce } from "./bounce.js";
import * as repo from "./mailouts.repository.js";

/**
 * Reading every mailbox the firm sends from, and turning what comes back into an answer.
 *
 * **Every mailbox, not one.** A bounce goes to the envelope sender, and which mailbox that is, is
 * the hosting's decision — production shows them arriving somewhere other than the configured
 * `From`. Since matching is done on a key carried INSIDE the report, it does not matter which
 * mailbox a given bounce lands in: read them all, match whatever turns up.
 *
 * **One mailbox's failure is its own.** A host that is down must not stop the others being read,
 * so each is swept inside its own try and its error is recorded against it rather than thrown.
 */

/** The read side of a mailbox, injected so the suite needs no IMAP server. */
type Fetcher = typeof fetchSince;

/** How a bounce found its letter, kept for the log because the two are not equally certain. */
type MatchBy = "message-id" | "address";

export interface SweepResult {
  mailbox: string;
  read: number;
  matched: number;
  unmatched: number;
  retired: number;
  error?: string;
}

/**
 * Find the row this report is about.
 *
 * The `Message-ID` is exact and is tried first. Falling back to the address is what makes the six
 * bounces already sitting in the firm's mailbox usable at all — they were sent before letters
 * carried a key — and it stays useful for any server that strips `References:`. It is narrowed to
 * letters sent BEFORE the report, most recent first, because a bounce cannot precede its cause.
 */
async function findRow(bounce: Bounce, arrivedAt: Date) {
  if (bounce.messageId) {
    const exact = await repo.findRecipientByMessageId(bounce.messageId);
    if (exact) return { row: exact, by: "message-id" as MatchBy };
  }
  const near = await repo.findRecipientByAddressBefore(bounce.email, arrivedAt);
  return near ? { row: near, by: "address" as MatchBy } : null;
}

/**
 * The sentence a reader sees under a letter that did not arrive.
 *
 * The headline names the fault; the server's own words follow, because a bookkeeper ringing their
 * client wants to be able to say what the other end actually said. The protocol code is not here:
 * it is kept in `bounceCode` for anyone diagnosing, and shown nowhere.
 */
function sentence(bounce: Bounce): string {
  const detail = bounce.reason.replace(/^\d{3}[- ]?[\d.]*\s*/, "").trim();
  return `${bounceHeadline(bounce.kind)}${detail ? ` — ${detail}` : ""}`.slice(0, 300);
}

/** Read one mailbox and apply everything it holds. Never throws; failure is part of the result. */
async function sweepMailbox(
  account: {
    id: string;
    name: string;
    imapHost: string | null;
    imapPort: number | null;
    imapSecure: boolean | null;
    imapUser: string | null;
    smtpUser: string | null;
    bounceLastUid: number | null;
    bounceUidValidity: string | null;
  },
  credentials: Parameters<Fetcher>[0],
  read: Fetcher,
): Promise<SweepResult> {
  const out: SweepResult = {
    mailbox: account.name,
    read: 0,
    matched: 0,
    unmatched: 0,
    retired: 0,
  };
  try {
    const { uidValidity, messages } = await read(credentials, account.bounceLastUid);
    // A reissued mailbox invalidates the bookmark: start again rather than skip everything.
    const restart =
      account.bounceUidValidity !== null && account.bounceUidValidity !== uidValidity;
    let lastUid = restart ? null : account.bounceLastUid;

    for (const message of messages) {
      out.read += 1;
      const bounce = parseBounce(message.source);
      if (bounce) {
        const hit = await findRow(bounce, new Date());
        if (!hit) {
          out.unmatched += 1;
        } else {
          out.matched += 1;
          await repo.markBounced(hit.row.id, {
            reason: sentence(bounce),
            bounceCode: bounce.code,
            bounceKind: bounce.kind,
          });
          // ONLY a dead recipient retires an address. A refused greeting names a live client in
          // `Final-Recipient` while the fault is our own server, and a full mailbox exists — acting
          // on either would turn one misconfiguration into a blocklist of real clients.
          if (bounce.kind === "address") {
            await repo.retireAddress(bounce.email, bounce.code, sentence(bounce));
            out.retired += 1;
          }
        }
      }
      // Moved for EVERY message, parsed or not: a report we cannot read must not be re-read for
      // ever, and ordinary mail in this box is simply not ours.
      lastUid = message.uid;
    }

    await repo.recordSweep(account.id, {
      bounceUidValidity: uidValidity,
      bounceLastUid: lastUid,
      bounceCheckedAt: new Date(),
      bounceError: null,
    });
  } catch (err) {
    const said = explainSendError(err, {
      host: account.imapHost,
      port: account.imapPort,
      protocol: "imap",
    }).message;
    out.error = said;
    // Recorded, not thrown: the next mailbox still gets read, and the screen shows this one as
    // broken rather than quietly stopping.
    await repo.recordSweep(account.id, { bounceError: said.slice(0, 300) }).catch(() => {});
    console.error(`[mailouts] could not read ${account.name}:`, err);
  }
  return out;
}

/**
 * Sweep every mailbox that is configured to be read. Safe to run on a timer and safe to run twice.
 *
 * Idempotent by construction: the bookmark only ever moves forward, and applying the same report
 * to the same row a second time writes the same values.
 */
export async function readBounces(
  resolve: (id: string) => Promise<Parameters<Fetcher>[0]>,
  /**
   * Injected so the suite can replay real reports without an IMAP server — and so the parsing,
   * matching and retiring can be proven without a network at all. The default is the real thing.
   */
  read: Fetcher = fetchSince,
): Promise<SweepResult[]> {
  const accounts = await repo.listBounceMailboxes();
  const results: SweepResult[] = [];
  for (const account of accounts) {
    try {
      results.push(await sweepMailbox(account, await resolve(account.id), read));
    } catch (err) {
      // Resolving credentials can fail on its own — a sealed password with no `SECRETS_KEY`.
      const said = explainSendError(err, { protocol: "imap" }).message;
      results.push({
        mailbox: account.name,
        read: 0,
        matched: 0,
        unmatched: 0,
        retired: 0,
        error: said,
      });
      await repo.recordSweep(account.id, { bounceError: said.slice(0, 300) }).catch(() => {});
    }
  }
  return results;
}
