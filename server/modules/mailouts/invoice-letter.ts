/**
 * The letter an invoice is emailed with (payments.md §12, owner 2026-11-22).
 *
 * Mailouts owns letters: the mailbox, the shell, the dead addresses. Payments owns the invoice: who
 * it is addressed to, its PDF and its sent mark. This file is the one door Payments sends through,
 * and it knows of the invoice only the values it is handed.
 *
 * Not a mailout: no `Mailout` row and no recipient log, because the invoice's sent mark and the
 * activity log are its record (owner). It goes inside the request, since a person is waiting on one
 * letter and has to hear at once when it did not go.
 *
 * Always transactional (§2): a client who unsubscribed from news still gets their bill, and the
 * letter carries no unsubscribe link and no postal address. Always from the mailbox marked for
 * invoices, whatever mailbox the template names.
 */
import {
  INVOICE_VARIABLES,
  renderMailText,
  type InvoiceVariableKey,
  type MailVars,
} from "@shared/mailouts.js";
import { AppError, ValidationError } from "../../core/errors.js";
import { sendRawEmail, type SmtpAccount } from "../../core/email.js";
import { LOGO_CID, renderLetter, renderLetterText } from "../../core/email-layout.js";
import { explainSendError } from "../../core/send-error.js";
import * as repo from "./mailouts.repository.js";
import {
  cidSrc,
  companyOf,
  contactsOf,
  dataSrc,
  deadAddresses,
  fromHeader,
  loadLogo,
  smtpFor,
  varsFor,
  type FirmProfile,
  type SenderAccount,
} from "./mailouts.service.js";

export interface InvoiceLetterRequest {
  clientId: string;
  companyId: string | null;
  /** where it goes: the invoice company's address, else the client's, the PDF's own rule */
  to: string | null;
  /** the invoice variables, written as the paper prints them; null where the invoice has none */
  invoice: Record<InvoiceVariableKey, string | null>;
}

export interface InvoiceLetterPreview {
  to: string | null;
  /** the invoice mailbox; null when none is marked */
  mailbox: { name: string; from: string } | null;
  subject: string | null;
  html: string | null;
  /** why it cannot go; null = it can */
  blockedReason: string | null;
}

type Template = NonNullable<Awaited<ReturnType<typeof repo.findInvoiceTemplate>>>;

interface Draft {
  account: SenderAccount;
  smtp: SmtpAccount;
  template: Template;
  firm: FirmProfile;
  vars: MailVars;
  to: string;
}

const INVOICE_KEYS = new Set<string>(INVOICE_VARIABLES.map((v) => v.key));
const AS_INVOICE = { invoice: true } as const;

/**
 * 503, as the files module's "storage unavailable": an answer the proxies in front pass through
 * with its sentence, where a 502 may come back as the proxy's own page.
 */
const cannotSend = (message: string) => new AppError(503, "send_failed", message);

/**
 * The mailbox's credentials, or why there are none: a sealed password no key opens (SECRETS_KEY
 * absent or rotated). Asked by the window too, so it never offers a Send that cannot work.
 */
function credentialsOf(account: SenderAccount): SmtpAccount | string {
  try {
    return smtpFor(account);
  } catch (err) {
    console.error(`[mailouts] invoice mailbox unusable, account=${account.id}:`, err);
    return `“${account.name}” cannot send: its stored password cannot be opened. Enter it again under Mailouts → Sender`;
  }
}

/** Why the firm's own setup stops every invoice letter, in the order somebody fixes it. */
function setupRefusal(account: SenderAccount | null, template: Template | null): string | null {
  if (!account) return "No mailbox sends invoices. Pick one under Mailouts → Sender";
  if (!account.active) {
    return `“${account.name}” sends invoices but is deactivated. Activate it under Mailouts → Sender`;
  }
  if (!template) {
    return "No letter is set for invoices. Choose Use for invoices on a template under Mailouts → Templates";
  }
  if (!template.active) return `The invoice template “${template.name}” is inactive`;
  return null;
}

/** The required values the letter uses and this invoice or card has none for, in one sentence. */
function missingSentence(missing: string[]): string | null {
  const named = (keys: string[]) => keys.map((key) => `{{${key}}}`).join(", ");
  const ofInvoice = missing.filter((key) => INVOICE_KEYS.has(key));
  const ofCard = missing.filter((key) => !INVOICE_KEYS.has(key));
  const parts = [
    ofInvoice.length ? `This invoice has no ${named(ofInvoice)}` : null,
    ofCard.length ? `Client card has no ${named(ofCard)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(". ") : null;
}

/**
 * Everything the letter needs, or the reason it cannot go. Read the same way for the window and for
 * the send, so the window cannot promise a letter the send would refuse.
 */
async function draft(
  req: InvoiceLetterRequest,
): Promise<{ draft: Draft | null; preview: InvoiceLetterPreview }> {
  const [firm, account, template, clients] = await Promise.all([
    repo.getFirmProfile(),
    repo.findInvoiceSenderAccount(),
    repo.findInvoiceTemplate(),
    repo.findSendableClients([req.clientId]),
  ]);
  const preview: InvoiceLetterPreview = {
    to: req.to,
    mailbox: account ? { name: account.name, from: fromHeader(account) } : null,
    subject: null,
    html: null,
    blockedReason: setupRefusal(account, template),
  };
  const client = clients[0];
  if (!account || !template || preview.blockedReason) return { draft: null, preview };
  const smtp = credentialsOf(account);
  if (typeof smtp === "string")
    return { draft: null, preview: { ...preview, blockedReason: smtp } };
  if (!client)
    return { draft: null, preview: { ...preview, blockedReason: "The client is archived" } };

  const company = companyOf(client, req.companyId);
  const vars: MailVars = {
    ...varsFor({ client, company }, account),
    email: req.to,
    ...req.invoice,
  };
  const texts = [template.subject, template.heading ?? "", template.body];
  const missing = new Set(
    texts.flatMap((text) => renderMailText(text, vars, AS_INVOICE).missing),
  );
  const subject = renderMailText(template.subject, vars, AS_INVOICE).text;
  const to = req.to;
  const blockedReason = !to
    ? `No email address on ${company ? `${company.name} or ` : ""}the client card`
    : ((await deadAddresses([to])).get(to.toLowerCase()) ?? missingSentence([...missing]));

  const next = { ...preview, subject, blockedReason };
  if (!to || blockedReason) return { draft: null, preview: next };
  return { draft: { account, smtp, template, firm, vars, to }, preview: next };
}

/** The shell around the text: the same frame as every letter, with nothing commercial in it. */
function letterOf(d: Draft, logoSrc: string | null) {
  const subject = renderMailText(d.template.subject, d.vars, AS_INVOICE).text;
  const shell = {
    heading: d.template.heading
      ? renderMailText(d.template.heading, d.vars, AS_INVOICE).text
      : subject,
    body: renderMailText(d.template.body, d.vars, AS_INVOICE).text,
    firmName: d.account.fromName,
    signature: d.account.signature,
    contacts: contactsOf(d.account),
    postalAddress: null,
    unsubscribeUrl: null,
    logoSrc,
    cta: null,
    facts: [],
  };
  return { subject, html: renderLetter(shell), text: renderLetterText(shell) };
}

/** What Send by email would do, with the letter as the client will read it. Sends nothing. */
export async function previewInvoiceLetter(
  req: InvoiceLetterRequest,
): Promise<InvoiceLetterPreview> {
  const { draft: d, preview } = await draft(req);
  if (!d) return preview;
  return { ...preview, html: letterOf(d, dataSrc(await loadLogo(d.firm))).html };
}

/**
 * Send it, the PDF attached. A refusal is a 400 with its sentence; a mailbox that cannot send is a
 * 503 with the sentence `explainSendError` gives, said to the person who pressed Send. The PDF is
 * asked for only once the letter can go: drawing one for a refusal is work nobody reads.
 */
export async function sendInvoiceLetter(
  req: InvoiceLetterRequest,
  drawPdf: () => Promise<{ filename: string; content: Buffer }>,
): Promise<{ to: string; mailbox: string }> {
  const { draft: d, preview } = await draft(req);
  if (!d) throw new ValidationError(preview.blockedReason ?? "This invoice cannot be emailed");

  const { smtp } = d;
  const [logo, pdf] = await Promise.all([loadLogo(d.firm), drawPdf()]);
  const letter = letterOf(d, cidSrc(logo));
  try {
    const messageId = await sendRawEmail({
      to: d.to,
      ...letter,
      from: fromHeader(d.account),
      replyTo: d.account.replyTo,
      account: smtp,
      attachments: [
        ...(logo ? [{ ...logo, cid: LOGO_CID }] : []),
        { filename: pdf.filename, content: pdf.content, contentType: "application/pdf" },
      ],
    });
    // no recipient row holds it (payments.md §12), so the server log is where a bounce that
    // quotes it can be traced back to this letter
    console.info(
      `[mailouts] invoice letter sent, account=${d.account.id} id=${messageId ?? "-"}`,
    );
  } catch (err) {
    const failure = explainSendError(err, { host: smtp.host, port: smtp.port });
    console.error(
      `[mailouts] invoice letter failed, account=${d.account.id} (${failure.fault}):`,
      err,
    );
    throw cannotSend(failure.message);
  }
  return { to: d.to, mailbox: d.account.name };
}
