/**
 * Turn an SMTP or network failure into a sentence a bookkeeper can act on.
 *
 * Nodemailer reports failures in the vocabulary of the protocol — `EAUTH`, `getaddrinfo
 * ENOTFOUND smtp.exmaple.com`, `535 5.7.8`. Pasting that beside a recipient's name told the
 * person reading it nothing except that something had gone wrong, which they could already see
 * from the status. The useful question is never "what is the error code", it is **who has to do
 * something about it** — and that is what `fault` answers:
 *
 *   settings   the firm's own mailbox is misconfigured; fix it under Mailouts → Sender
 *   address    this client's address is wrong; fix it on their card
 *   letter     this particular letter was unacceptable (usually size)
 *   temporary  nobody did anything wrong; the far server is busy and it should be retried
 *   unknown    we could not classify it — the raw message is passed through rather than hidden
 *
 * The raw error is NOT discarded: callers log it. This decides what to show, not what to keep.
 */
export type SendFault = "settings" | "address" | "letter" | "temporary" | "unknown";

export interface SendFailure {
  message: string;
  fault: SendFault;
  /**
   * Whether trying the very same send again could plausibly work.
   *
   * A permanent refusal is permanent by definition: retrying a `550 no such user` cannot succeed,
   * it just knocks on the receiving server twice with the same bad address — which costs wall
   * time on a long run and does the sending domain's reputation no favours.
   */
  retryable: boolean;
}

export interface SendErrorContext {
  host?: string | null;
  port?: number | null;
  /**
   * Which conversation failed. It changes the advice, not the classification.
   *
   * The SSL-on-the-wrong-port hint has to name the RIGHT ports: 465/587 for submission, 993/143
   * for IMAP. Telling somebody configuring a mailbox reader to check port 587 sends them to the
   * wrong field on the same screen, which is worse than saying nothing.
   */
  protocol?: "smtp" | "imap";
}

/**
 * Structured detail hung off an Error by the two libraries that talk mail here.
 *
 * Nodemailer and ImapFlow disagree about almost everything: nodemailer reports `code: "EAUTH"` with
 * a numeric `responseCode`, while ImapFlow throws `message: "Command failed"` — the same four words
 * for a refused password, a missing mailbox and a syntax error — and puts the truth in
 * `responseText` with an `authenticationFailed` flag beside it. Reading only the first shape meant
 * the single most common mailbox mistake came out as "Command failed", which is exactly the
 * protocol jargon this module exists to remove.
 */
interface SmtpishError {
  message?: unknown;
  code?: unknown;
  command?: unknown;
  responseCode?: unknown;
  response?: unknown;
  /** ImapFlow: the server's own words, where nodemailer would have used `response` */
  responseText?: unknown;
  /** ImapFlow: set on a refused LOGIN, which carries no numeric code at all */
  authenticationFailed?: unknown;
}

/** True when ImapFlow says the sign-in itself was refused. */
function authRefused(err: unknown): boolean {
  return (
    !!err && typeof err === "object" && (err as SmtpishError).authenticationFailed === true
  );
}

function field(err: unknown, key: keyof SmtpishError): string {
  if (!err || typeof err !== "object") return "";
  const v = (err as SmtpishError)[key];
  return typeof v === "string" ? v : "";
}

function responseCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const v = (err as SmtpishError).responseCode;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The most informative text the error carries.
 *
 * ImapFlow's `message` is the constant "Command failed"; what actually happened is in
 * `responseText`. Preferring it means an unrecognised IMAP failure still shows the server's own
 * sentence rather than four words that fit every failure equally.
 */
function rawMessage(err: unknown): string {
  const detail = field(err, "responseText").trim();
  if (detail && (!(err instanceof Error) || err.message === "Command failed")) return detail;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

/** `smtp.exmaple.com` out of `getaddrinfo ENOTFOUND smtp.exmaple.com`, when the context has none. */
function hostFrom(text: string): string {
  const m = /ENOTFOUND\s+(\S+)/i.exec(text);
  return m ? m[1] : "";
}

/** Names the server for the START of a sentence, so it never opens in lower case. */
const AT = (ctx: SendErrorContext, fallback: string) => {
  const host = ctx.host || fallback;
  if (!host) return "The mail server";
  return ctx.port ? `${host}:${ctx.port}` : host;
};

export function explainSendError(err: unknown, ctx: SendErrorContext = {}): SendFailure {
  const raw = rawMessage(err).trim();
  const code = field(err, "code").toUpperCase();
  const command = field(err, "command").toUpperCase();
  const response = field(err, "response").trim();
  const status = responseCode(err);
  const said = response || raw;

  // Our own `RCPT TO` refusal, thrown by `sendRawEmail` when nodemailer resolves with a rejected
  // address rather than throwing. It already names the address and quotes the server.
  if (/^The mail server refused /.test(raw)) {
    return { message: raw, fault: "address", retryable: false };
  }

  // Severity outranks symptom, and it has to be asked FIRST. A 4xx is transient by RFC 5321 no
  // matter which command provoked it, but nodemailer labels the SYMPTOM: a busy server answering
  // `421` at greeting arrives as `ECONNECTION`, and a `454 temporary authentication failure`
  // arrives as `EAUTH`. Reading those codes before the number sent people to re-check a host that
  // was right and to retype a password that was correct — and, worse, refused the retry that
  // would have worked.
  if (status !== null && status >= 400 && status < 500) {
    return {
      message: `The mail server is busy or throttling and asked us to try later — nothing is wrong with the settings or the address. It said: ${said}`,
      fault: "temporary",
      retryable: true,
    };
  }

  // ── the firm's own mailbox ────────────────────────────────────────────────
  if (
    authRefused(err) ||
    code === "EAUTH" ||
    status === 535 ||
    status === 534 ||
    status === 530
  ) {
    return {
      message:
        ctx.protocol === "imap"
          ? "The mailbox rejected our username or password for reading — check the IMAP credentials under Mailouts → Sender."
          : "The mailbox rejected our username or password — check the credentials under Mailouts → Sender.",
      fault: "settings",
      retryable: false,
    };
  }
  if (code === "ENOTFOUND" || code === "EDNS" || /ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    const host = ctx.host || hostFrom(raw);
    return {
      message: `Cannot find the mail server${host ? ` “${host}”` : ""} — check the ${ctx.protocol === "imap" ? "IMAP" : "SMTP"} host under Mailouts → Sender.`,
      fault: "settings",
      retryable: false,
    };
  }
  if (code === "ECONNREFUSED" || /ECONNREFUSED/i.test(raw)) {
    return {
      message: `${AT(ctx, "")} refused the connection — check the port and the SSL setting under Mailouts → Sender.`,
      fault: "settings",
      retryable: false,
    };
  }
  // The single most common real misconfiguration: SSL on the wrong port. 465 speaks TLS from the
  // first byte, 587 starts in the clear and upgrades — crossing them produces a protocol error
  // whose text ("wrong version number") explains nothing to the person who has to fix it.
  if (
    /wrong version number|SSL routines|ERR_TLS|packet length too long/i.test(raw) ||
    /certificate/i.test(raw)
  ) {
    return {
      message: /certificate/i.test(raw)
        ? `The mail server's security certificate was not accepted — check the host and SSL setting under Mailouts → Sender.`
        : ctx.protocol === "imap"
          ? `The SSL setting does not match the port — port 993 needs SSL on, port 143 needs it off.`
          : `The SSL setting does not match the port — port 465 needs SSL on, port 587 needs it off.`,
      fault: "settings",
      retryable: false,
    };
  }
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKET" ||
    code === "ECONNECTION" ||
    code === "EHOSTUNREACH" ||
    /timed? ?out|Greeting never received|Connection closed/i.test(raw)
  ) {
    return {
      message: `${AT(ctx, "")} did not answer — check the host, port and SSL setting under Mailouts → Sender.`,
      fault: "settings",
      retryable: true,
    };
  }
  // A server that authenticated us but will not let us send AS this From. Distinct from a bad
  // recipient even though both arrive as 5xx, and the fix is in a different screen entirely.
  if (
    command === "MAIL FROM" ||
    (status !== null && status >= 500 && /sender|from/i.test(said))
  ) {
    return {
      message: `The mail server will not let this mailbox send as that From address — most servers only send as the account that signed in. It said: ${said}`,
      fault: "settings",
      retryable: false,
    };
  }

  // ── the letter ────────────────────────────────────────────────────────────
  if (
    status === 552 ||
    status === 523 ||
    /message (file )?too (big|large)|size exceeds/i.test(said)
  ) {
    return {
      message: "The letter was too large for the mail server to accept.",
      fault: "letter",
      retryable: false,
    };
  }

  // ── the recipient's address ───────────────────────────────────────────────
  if (command === "RCPT TO" || (status !== null && status >= 500 && status < 600)) {
    return {
      message: `The receiving mail server refused the address — ${said}`,
      fault: "address",
      retryable: false,
    };
  }

  return {
    message: raw || "The letter could not be sent.",
    fault: "unknown",
    retryable: true,
  };
}
