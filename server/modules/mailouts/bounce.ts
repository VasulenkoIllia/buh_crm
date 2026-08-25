/**
 * Reading a delivery report.
 *
 * The rules here were written against six real bounces (`bounce-fixtures/`), and every one of them
 * changed something an invented sample would have agreed with. The important ones:
 *
 *   - **`Status:` is useless.** Exim writes a generic `5.0.0` for every kind of failure. The reason
 *     lives in `Diagnostic-Code:`.
 *   - **The enhanced code is optional.** Yahoo reports a dead mailbox as bare `552` with no `5.x.y`
 *     anywhere, so classifying on the number alone filed it as "the letter was too large" — never
 *     blacklisting an address that is gone.
 *   - **Wording outranks the number.** "mailbox not found" means the address died whatever code
 *     carried it.
 *
 * Pure: text in, verdict out. No mailbox, no database, no clock.
 */

/** What the failure was ABOUT, which decides what may be done in response. */
export type BounceKind =
  /** the recipient's mailbox is gone — the only kind that may retire an address */
  | "address"
  /** a mail system between us and them, quite possibly our own — blame no address for it */
  | "system"
  /** the message itself was unacceptable, usually its size */
  | "letter"
  /** 4.x.x — still being retried by the sending server; nothing to record against anyone */
  | "transient";

export interface Bounce {
  /** the address that failed, lower-cased */
  email: string;
  /** the original `Message-ID`, when the report quotes one — the exact join key */
  messageId: string | null;
  kind: BounceKind;
  /** the enhanced code when present, else the bare three-digit reply */
  code: string;
  /** the receiving server's own words, trimmed to something a person can read */
  reason: string;
  /** which SMTP command drew the refusal: RCPT TO, HELO, end of data… */
  stage: string | null;
}

const HEADER = (raw: string, name: string): string | null => {
  // Unfolds continuation lines, which is how every long header in a DSN arrives.
  const re = new RegExp(`^${name}:[ \\t]*([^\\n]*(?:\\n[ \\t]+[^\\n]*)*)`, "im");
  const m = re.exec(raw);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
};

/** True when this looks like a delivery report rather than ordinary mail. */
export function isDeliveryReport(raw: string): boolean {
  const type = HEADER(raw, "content-type") ?? "";
  if (/report-type=["']?delivery-status/i.test(type)) return true;
  // Servers that send a plain-text notice instead of a proper report still announce themselves.
  const from = (HEADER(raw, "from") ?? "").toLowerCase();
  return /mailer-daemon|postmaster/.test(from);
}

/**
 * Wording that names a dead RECIPIENT mailbox, whatever code the server attached to it.
 *
 * "Sender address rejected" is deliberately absent. It contains "address rejected" and was being
 * read as a dead recipient — so a server refusing OUR From would have retired a live client's
 * address. Anything about the sender belongs to `SYSTEM_WORDS`.
 */
const ADDRESS_WORDS =
  /no such (user|mailbox|recipient)|user unknown|does not exist|doesn'?t exist|mailbox not found|unknown user|recipient (address )?rejected|invalid recipient|user not found|no mailbox here/i;
const FULL_WORDS = /mailbox (is )?full|over quota|quota exceeded|insufficient storage/i;

/** Wording that blames a mail system — ours or theirs — and never the recipient. */
const SYSTEM_WORDS =
  /sender (address )?(rejected|verify|denied)|from address|\bhelo\b|\behlo\b|\bspf\b|dkim|dmarc|relay (access )?denied|not permitted to send|blocked using|blacklist|spam|policy/i;
const SIZE_WORDS =
  /message (file )?too (big|large)|size (of the message )?exceeds|exceeds (the )?(fixed )?maximum/i;

/**
 * What a diagnostic means.
 *
 * Order matters and is the lesson of the fixtures: the words are consulted before the number,
 * because Yahoo's `552 … mailbox not found` is a dead address wearing the code for an oversized
 * message. A classifier that trusted the number would have kept writing to it forever.
 */
export function classify(diagnostic: string): { kind: BounceKind; code: string } {
  const enhanced = /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(diagnostic)?.[1] ?? null;
  const basic = /\b([245]\d\d)\b/.exec(diagnostic)?.[1] ?? null;
  const code = enhanced ?? basic ?? "";
  const severity = (enhanced ?? basic ?? "5")[0];

  // Transient first: nothing else may act on a failure the sending server is still retrying.
  if (severity === "4") return { kind: "transient", code };

  // A full mailbox EXISTS. Retiring it would lose a client over a week of holiday photographs.
  if (FULL_WORDS.test(diagnostic)) return { kind: "system", code };
  // Ahead of the address words, because "Sender address rejected" contains "address rejected" and
  // is about US. Reading it as a dead recipient would retire a live client over our own setup.
  if (SYSTEM_WORDS.test(diagnostic)) return { kind: "system", code };
  if (ADDRESS_WORDS.test(diagnostic)) return { kind: "address", code };
  if (SIZE_WORDS.test(diagnostic)) return { kind: "letter", code };

  if (enhanced?.startsWith("5.1.")) return { kind: "address", code };
  if (enhanced?.startsWith("5.2.")) return { kind: "system", code };
  if (enhanced?.startsWith("5.3.")) return { kind: "system", code };
  if (enhanced?.startsWith("5.5.")) return { kind: "system", code };
  return { kind: "system", code };
}

/**
 * The stage of the conversation the refusal arrived at.
 *
 * Matched against the known verbs rather than "everything up to the colon", which dragged the
 * command's argument along with it — `HELO illion-web` instead of `HELO`. The stage is what
 * corroborates the classification: `RCPT TO` and `end of data` mean the recipient was examined;
 * `HELO` and `MAIL FROM` mean it never was, so no address is implicated.
 */
function stageOf(raw: string): string | null {
  const m =
    /SMTP error from remote mail server after (end of data|initial connection|connection|MAIL FROM|RCPT TO|STARTTLS|HELO|EHLO|DATA|BDAT|AUTH)/i.exec(
      raw,
    );
  return m ? m[1].toUpperCase().replace("END OF DATA", "end of data") : null;
}

/**
 * The diagnostic as one line.
 *
 * `Diagnostic-Code:` folds across several lines and repeats the enhanced code on each, which reads
 * as gibberish once unfolded ("550-5.1.1 … 550-5.1.1 … 550 5.1.1 …"). The leading repeats are
 * dropped so what reaches the screen is a sentence.
 */
function tidy(diagnostic: string): string {
  let kept = false;
  return (
    diagnostic
      .replace(/\s+/g, " ")
      .trim()
      // "smtp; 550 …" — the type prefix names the protocol, and no reader needs telling.
      .replace(/^(smtp|x-[\w-]+)\s*;\s*/i, "")
      // Keep the FIRST code and drop every later repeat. An earlier attempt dropped them all,
      // which left the classifier reading a three-digit number out of Google's session id.
      .replace(/\b\d{3}[- ]\d{1,3}\.\d{1,3}\.\d{1,3}\b[ ]*/g, (m) => {
        if (kept) return "";
        kept = true;
        return m;
      })
      .replace(/\s*https?:\/\/\S+/g, "")
      // Google signs off with an opaque session id: it identifies the conversation, not the failure.
      .replace(/\s+[\w-]{16,}\s*-\s*g?smtp\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Read one report. Returns null when the message is not one, or names no failed address.
 *
 * The join key is taken from `References:` — the original `Message-ID`, quoted back — with the
 * failed address as the fallback the caller matches on when it is absent.
 */
export function parseBounce(raw: string): Bounce | null {
  if (!isDeliveryReport(raw)) return null;

  const email =
    HEADER(raw, "x-failed-recipients") ??
    /^Final-Recipient:\s*[^;]*;\s*(.+)$/im.exec(raw)?.[1]?.trim() ??
    null;
  if (!email) return null;

  const diagRaw =
    /^Diagnostic-Code:[ \t]*([^\n]*(?:\n[ \t]+[^\n]*)*)/im.exec(raw)?.[1] ??
    /SMTP error from remote mail server[^\n]*\n((?:[ \t]+[^\n]+\n?)+)/i.exec(raw)?.[1] ??
    "";
  const diagnostic = tidy(diagRaw);

  const references = HEADER(raw, "references");
  const messageId = references ? (/<([^>]+)>/.exec(references)?.[0] ?? null) : null;

  return {
    email: email.split(",")[0].trim().toLowerCase(),
    messageId,
    ...classify(diagnostic),
    reason: diagnostic || "The receiving server gave no reason.",
    stage: stageOf(raw),
  };
}
