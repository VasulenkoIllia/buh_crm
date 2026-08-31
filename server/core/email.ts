import nodemailer, { type Transporter } from "nodemailer";
import { config, isDev } from "./config.js";
import { renderLetter, renderLetterText } from "./email-layout.js";
import { explainSendError } from "./send-error.js";

// Shared SMTP transport (Nodemailer → Mailpit in dev). Modules never touch SMTP
// directly — they call sendEmail(template, to, data). Treated as an unreliable
// boundary: retried, never blocks the request path (callers fire-and-forget).
//
// There are two doors, and the difference matters:
//
//   sendEmail()     — the built-in transactional letters (invite, password reset). Their bodies
//                     are code, their names are a closed TypeScript union, and callers
//                     fire-and-forget because a failed invite must not fail the request.
//   sendRawEmail()  — mailouts, whose subject and body come from the DATABASE and so can never be
//                     a member of that union. Awaited, not fire-and-forget: the mailout log
//                     records what happened to each recipient, which is only possible if the
//                     caller finds out.

export interface EmailTemplates {
  invite: { inviteUrl: string; invitedBy: string };
  passwordReset: { resetUrl: string };
}

export type EmailTemplateName = keyof EmailTemplates;

/** The web origin used in email links (dev = Vite, prod = the real domain). */
export function webOrigin(): string {
  return isDev ? "http://localhost:5173" : `https://${config.APP_DOMAIN}`;
}

/**
 * What a system letter SAYS. Not how it looks.
 *
 * These used to be three bare `<p>` tags each, sent with no shell and no text part, while the
 * letters clients receive went through `renderLetter` — one app, two completely different-looking
 * kinds of mail (user, 2026-08-31). A template now returns content, and the shell dresses it, so
 * adding the notification letters later means adding a case here and nothing else.
 *
 * `body` is PLAIN TEXT on purpose: the shell escapes it, which is why the link lives in `cta`
 * rather than inside a sentence.
 */
function render<T extends EmailTemplateName>(
  template: T,
  data: EmailTemplates[T],
): {
  subject: string;
  heading: string;
  body: string;
  cta: { label: string; url: string } | null;
  facts: Array<{ label: string; value: string }>;
} {
  switch (template) {
    case "invite": {
      const d = data as EmailTemplates["invite"];
      return {
        subject: `You are invited to ${config.APP_NAME}`,
        heading: `You are invited to ${config.APP_NAME}`,
        body:
          `${d.invitedBy} invited you to the ${config.APP_NAME} CRM.\n\n` +
          `Set a password to activate your account. The link expires in 7 days.`,
        cta: { label: "Set your password", url: d.inviteUrl },
        facts: [{ label: "Invited by", value: d.invitedBy }],
      };
    }
    case "passwordReset": {
      const d = data as EmailTemplates["passwordReset"];
      return {
        subject: `Reset your ${config.APP_NAME} password`,
        heading: "Reset your password",
        body:
          `Someone requested a password reset for your account.\n\n` +
          `If it wasn't you, ignore this email and nothing will change.`,
        cta: { label: "Set a new password", url: d.resetUrl },
        facts: [],
      };
    }
  }
  throw new Error(`Unknown email template: ${template}`);
}

function dress(
  to: string,
  content: ReturnType<typeof render>,
): { html: string; text: string } {
  const shell = {
    heading: content.heading,
    body: content.body,
    // `APP_NAME`, not a read of the firm profile. A password reset must not depend on a database
    // query: it is the letter someone needs precisely when they cannot get in, and adding a read
    // to that path adds a way for it to fail. `bootstrap` seeds the firm profile FROM this name,
    // so the two agree unless the firm renames itself — set `APP_NAME` to the firm's own name and
    // the masthead draws it (the wordmark lockup included).
    firmName: config.APP_NAME,
    signature: null,
    contacts: {},
    postalAddress: null,
    unsubscribeUrl: null,
    logoSrc: null,
    cta: content.cta,
    // the address it was sent to leads every system letter: the first thing a reader needs is
    // proof it concerns them, and a template cannot forget to say so if it never says it
    facts: [{ label: "Account", value: to }, ...content.facts],
  };
  return { html: renderLetter(shell), text: renderLetterText(shell) };
}

/** Test outbox — in NODE_ENV=test emails are collected here instead of sent. */
export const testOutbox: Array<{
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
}> = [];

/**
 * A second SMTP account, for mailouts.
 *
 * Kept apart from the `.env` account on purpose: a spam complaint damages the reputation of the
 * address it was sent from, and the `.env` address is the one that delivers password resets. A
 * reset in a spam folder locks someone out of the CRM (decision 2026-08-11).
 */
export interface SmtpAccount {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
}

const transporters = new Map<string, Transporter>();

function buildTransport(account: SmtpAccount): Transporter {
  return nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure,
    // On a submission port (587, secure=false) force STARTTLS instead of relying on
    // opportunistic upgrade — many providers (e.g. illion.tax) reject plaintext AUTH,
    // which otherwise fails silently. Skipped in dev so Mailpit (no TLS) still works.
    requireTLS: !isDev && !account.secure,
    auth: account.user ? { user: account.user, pass: account.pass ?? undefined } : undefined,
    // fail fast instead of hanging on an unreachable host
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** The account from `.env` — invites, password resets, and mailouts until a second one is set. */
export function envAccount(): SmtpAccount {
  return {
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    user: config.SMTP_USER || null,
    pass: config.SMTP_PASS || null,
  };
}

/**
 * Transports are pooled per account, keyed by everything that defines a connection. Rebuilding one
 * per send would open a fresh TCP+TLS handshake for every recipient of a hundred-client mailout;
 * keying by the password as well means editing the account in Settings takes effect at once
 * instead of leaving a stale authenticated connection behind.
 */
function getTransporter(account: SmtpAccount): Transporter {
  const key = `${account.host}:${account.port}:${account.secure}:${account.user ?? ""}:${account.pass ?? ""}`;
  let t = transporters.get(key);
  if (!t) {
    t = buildTransport(account);
    transporters.set(key, t);
  }
  return t;
}

const MAX_ATTEMPTS = 3;

export async function sendEmail<T extends EmailTemplateName>(
  template: T,
  to: string,
  data: EmailTemplates[T],
): Promise<void> {
  const content = render(template, data);
  const { subject } = content;
  const { html, text } = dress(to, content);

  if (config.NODE_ENV === "test") {
    testOutbox.push({ to, subject, html, text });
    return;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await getTransporter(envAccount()).sendMail({
        from: config.MAIL_FROM,
        to,
        subject,
        html,
        // Not decoration: a message with no text/plain part scores measurably worse with spam
        // filters, and it is the only version some clients show. These letters had none until the
        // shell brought one with it.
        text,
      });
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }
  // never swallow silently — a broken SMTP config must be visible in the server logs
  console.error(
    `[email] send failed after ${MAX_ATTEMPTS} attempts — template=${template} to=${to}:`,
    lastError,
  );
  throw lastError;
}

// ── the second door: letters whose text comes from the database ──────────────

export interface RawEmail {
  to: string;
  subject: string;
  html: string;
  /** the text/plain alternative. Omitting it measurably worsens spam scoring. */
  text?: string;
  /** `"ILLION Tax & Accounting <info@illion.tax>"`; falls back to MAIL_FROM */
  from?: string | null;
  replyTo?: string | null;
  attachments?: Array<{
    filename: string;
    content: Buffer;
    cid?: string;
    contentType?: string;
  }>;
  /** extra headers — `List-Unsubscribe` and friends, which Gmail and Yahoo now require of bulk mail */
  headers?: Record<string, string>;
  /** which SMTP account to send over; defaults to the `.env` one */
  account?: SmtpAccount | null;
}

/**
 * Send a letter built at runtime, and REPORT the outcome to the caller.
 *
 * Two attempts, not three: a mailout to a hundred clients calls this a hundred times, and a dead
 * SMTP host would otherwise triple an already long wall time. One retry absorbs a transient blip;
 * anything worse is recorded against the recipient as `failed`, and the firm re-sends to just
 * those from the log. That is better than a longer retry loop, because it is visible.
 */
/**
 * Open a connection to an SMTP account and authenticate — without sending anything.
 *
 * The point is to fail HERE, in front of somebody who can fix it, rather than silently against a
 * hundred recipients at 3am. Nodemailer's `verify()` performs the real handshake, STARTTLS and
 * AUTH, so a wrong password or an unreachable host is caught for what it is.
 *
 * A fresh transport every time, not the pool: the whole question is whether these credentials work
 * right now, and a pooled connection authenticated with the previous ones would answer the wrong
 * question.
 */
export async function verifyAccount(account: SmtpAccount): Promise<void> {
  const transport = buildTransport(account);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

/**
 * What the mail server said NO to, as a sentence — or null when it took everything.
 *
 * A resolved send is not a delivered letter, and it is not even an accepted one. When the
 * receiving server refuses an address at `RCPT TO` — the usual answer for a mailbox that does not
 * exist on a domain it is authoritative for — nodemailer does NOT throw: it resolves, with that
 * address in `rejected`. Discarding the result therefore recorded "sent" about a letter the server
 * had just declined to take, which is the worst kind of wrong: confident.
 *
 * What this still cannot see is an address accepted here and bounced minutes later, which is a
 * different mechanism entirely (see the delivery backlog). This only stops us claiming success for
 * a refusal we were told about to our face.
 */
export function refusalOf(info: {
  rejected?: (string | { address?: string })[];
  rejectedErrors?: { message?: string }[];
  response?: string;
}): string | null {
  if (!info.rejected?.length) return null;
  const who = info.rejected
    .map((r) => (typeof r === "string" ? r : (r.address ?? "")))
    .filter(Boolean)
    .join(", ");
  const said = (info.rejectedErrors?.[0]?.message ?? info.response ?? "").toString().trim();
  return `The mail server refused ${who || "the recipient"}${said ? ` — ${said}` : ""}`;
}

/**
 * Returns the `Message-ID` the letter went out with, when the transport reports one.
 *
 * A bounce quotes it back in `References:`, so it is the key that ties a returned letter to the
 * row that sent it — exactly, rather than guessed at from the address and a timestamp. It was
 * being thrown away; keeping it costs nothing and is what makes reading bounces possible.
 */
export async function sendRawEmail(email: RawEmail): Promise<string | null> {
  if (config.NODE_ENV === "test") {
    testOutbox.push({
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      from: email.from ?? config.MAIL_FROM,
      replyTo: email.replyTo ?? undefined,
    });
    // A stand-in id rather than null, so the path that stores the key is exercised by the suite.
    // Returning null here left the one line that threads it through untested — and an untested
    // wire between two tested ends is exactly where this kind of thing goes wrong.
    return `<outbox-${testOutbox.length}@test.local>`;
  }

  const account = email.account ?? envAccount();
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const info = await getTransporter(account).sendMail({
        from: email.from || config.MAIL_FROM,
        to: email.to,
        replyTo: email.replyTo || undefined,
        subject: email.subject,
        html: email.html,
        text: email.text,
        attachments: email.attachments,
        headers: email.headers,
      });

      const refusal = refusalOf(info);
      if (refusal) throw new Error(refusal);
      return typeof info.messageId === "string" ? info.messageId : null;
    } catch (err) {
      lastError = err;
      // A permanent refusal is permanent by definition: a second `550 no such user` costs wall
      // time on a long run and knocks on the receiving server twice with the same bad address,
      // which does the sending domain's reputation no favours. Only a blip is worth a retry.
      if (!explainSendError(err).retryable) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastError;
}
