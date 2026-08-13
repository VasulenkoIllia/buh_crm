import { z } from "zod";
import { uuid } from "./common.js";
import { mailoutKind, mailoutStatus } from "./enums.js";

/**
 * Client mailouts (S10).
 *
 * Two kinds of letter, and the difference is legal rather than cosmetic (see `MailoutKind` in the
 * Prisma schema): `commercial` mail honours unsubscribe and must carry the firm's postal address;
 * `transactional` mail — an invoice, a document request — does neither, because a client who
 * unsubscribed from news still has to receive their bill.
 *
 * The `{{merge_var}}` catalog and the renderer live in `shared/mailouts.ts`, zod-free, so the
 * browser preview and the server send are literally the same function.
 */

export const emailTemplateSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  subject: z.string().min(1),
  /** drawn above the body; falls back to the subject when null */
  heading: z.string().nullable(),
  body: z.string().min(1),
  kind: mailoutKind,
  active: z.boolean(),
  /** the mailbox letters from this template usually go from; null = the firm's default */
  senderAccountId: uuid.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

const letterFields = z.object({
  subject: z.string().trim().min(1, "Required").max(200),
  heading: z
    .string()
    .max(200)
    .transform((v) => v.trim() || null)
    .nullable()
    .optional(),
  body: z.string().trim().min(1, "Required").max(20_000),
});

export const createTemplateInput = letterFields.extend({
  name: z.string().trim().min(1, "Required").max(80),
  kind: mailoutKind.default("commercial"),
  senderAccountId: uuid.nullable().optional(),
});
export type CreateTemplateInput = z.infer<typeof createTemplateInput>;

export const updateTemplateInput = createTemplateInput.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateTemplateInput = z.infer<typeof updateTemplateInput>;

// ── sending ──────────────────────────────────────────────────────────────────

/**
 * One addressee of a send: a client, or one of that client's companies.
 *
 * A client can hold several companies, each with its own inbox — the accountant writes to Olena
 * about her personal return and to Kvitka Trade LLC about its payroll, and those are different
 * letters to different addresses. `companyId` names which; absent means the client's own address.
 *
 * The company is always named ALONGSIDE its client rather than on its own, because everything the
 * letter needs beyond the address — who to greet, whether they have opted out — belongs to the
 * person, not the company.
 */
export const mailoutTarget = z.object({
  clientId: uuid,
  /** null or absent = the client's own address; otherwise one of that client's companies */
  companyId: uuid.nullable().optional(),
});
export type MailoutTarget = z.infer<typeof mailoutTarget>;

/**
 * A send names its recipients explicitly.
 *
 * Deliberately NOT "audience: all clients" — that is a campaign, and campaigns are a later round.
 * The firm picks who, sees the preview, and sends. Nothing goes out that a person did not look at.
 */
export const sendMailoutInput = z
  .object({
    /** use a saved template… */
    templateId: uuid.nullable().optional(),
    /** …or write a one-off letter. Ignored when `templateId` is set. */
    letter: letterFields.extend({ kind: mailoutKind.default("commercial") }).nullable().optional(),
    recipients: z.array(mailoutTarget).min(1, "Pick at least one recipient").max(500),
    /** which mailbox to send from; omitted = the template's, else the firm's default */
    senderAccountId: uuid.nullable().optional(),
  })
  .refine((v) => !!v.templateId !== !!v.letter, {
    path: ["templateId"],
    message: "Send either a saved template or a one-off letter, not both",
  });
export type SendMailoutInput = z.infer<typeof sendMailoutInput>;

/** What the composer shows before anything is sent — one row per chosen addressee. */
export const mailoutPreviewRow = z.object({
  clientId: uuid,
  /** null = the client's own address */
  companyId: uuid.nullable(),
  clientName: z.string(),
  /** the company this row is addressed to, so a client's three rows are told apart */
  companyName: z.string().nullable(),
  email: z.string().nullable(),
  subject: z.string(),
  /** why this addressee will be skipped; null = they will be sent to */
  blockedReason: z.string().nullable(),
});
export type MailoutPreviewRow = z.infer<typeof mailoutPreviewRow>;

export const mailoutPreviewSchema = z.object({
  /**
   * No rendered letter here, deliberately.
   *
   * "What does this look like" already has two answers — the template editor and the kind
   * switcher's full-size view — and repeating it on the send screen made a picture compete with
   * the one question this step exists for: who is about to be written to, and who is not.
   */
  subject: z.string(),
  rows: z.array(mailoutPreviewRow),
  sendable: z.number().int(),
  blocked: z.number().int(),
  /** `{{typos}}` the letter references that are not in the catalog */
  unknownVariables: z.array(z.string()),
  /** which mailbox this resolved to, so the composer can show it before anything is sent */
  senderAccountId: uuid,
  senderAccountName: z.string(),
  senderFrom: z.string(),
});
export type MailoutPreview = z.infer<typeof mailoutPreviewSchema>;

export const previewMailoutInput = sendMailoutInput;
export type PreviewMailoutInput = SendMailoutInput;

/**
 * Render a letter with SAMPLE values and no recipients — "show me what this looks like", asked
 * from the template editor.
 *
 * Separate from `previewMailoutInput` because that one needs clients, and needing to pick a
 * recipient before you can look at your own layout is the wrong shape for the question. The
 * composer's preview stays the one that answers "who will actually get this".
 */
export const previewLetterInput = letterFields.extend({
  kind: mailoutKind.default("commercial"),
  /** render through this mailbox's From and signature; omitted = the default mailbox */
  senderAccountId: uuid.nullable().optional(),
});
export type PreviewLetterInput = z.infer<typeof previewLetterInput>;

export const letterPreviewSchema = z.object({
  subject: z.string(),
  /** the letter as a client sees it */
  html: z.string(),
  /**
   * The same letter with every substituted value picked out in colour.
   *
   * Both come back from one render, so the toggle can never show a letter assembled differently
   * from the one it claims to be describing — it only chooses which of two already-identical
   * documents to display.
   */
  highlightedHtml: z.string(),
  /** the catalog variables this letter actually uses, so the legend names what the colour marks */
  variablesUsed: z.array(z.string()),
  /** `{{typos}}` the letter references that are not in the catalog */
  unknownVariables: z.array(z.string()),
  /** false when the firm has no postal address — a commercial send would be refused */
  sendable: z.boolean(),
  blockedReason: z.string().nullable(),
});
export type LetterPreview = z.infer<typeof letterPreviewSchema>;

// ── the log ──────────────────────────────────────────────────────────────────

export const mailoutRecipientSchema = z.object({
  id: uuid,
  clientId: uuid,
  companyId: uuid.nullable(),
  clientName: z.string(),
  /** null = it went to the client's own address */
  companyName: z.string().nullable(),
  email: z.string(),
  status: mailoutStatus,
  reason: z.string().nullable(),
  sentAt: z.iso.datetime().nullable(),
});
export type MailoutRecipientRow = z.infer<typeof mailoutRecipientSchema>;

export const mailoutSchema = z.object({
  id: uuid,
  templateId: uuid.nullable(),
  templateName: z.string().nullable(),
  subject: z.string(),
  heading: z.string().nullable(),
  body: z.string(),
  kind: mailoutKind,
  createdById: uuid.nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  counts: z.object({
    sent: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    queued: z.number().int(),
  }),
});
export type Mailout = z.infer<typeof mailoutSchema>;

export const mailoutDetailSchema = mailoutSchema.extend({
  recipients: z.array(mailoutRecipientSchema),
});
export type MailoutDetail = z.infer<typeof mailoutDetailSchema>;

export const mailoutListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type MailoutListQuery = z.infer<typeof mailoutListQuery>;

export const mailoutListSchema = z.object({
  items: z.array(mailoutSchema),
  total: z.number().int(),
});
export type MailoutList = z.infer<typeof mailoutListSchema>;

// ── the client card ──────────────────────────────────────────────────────────

/** One letter this client received, for the card's Mailouts tab. */
export const clientMailoutRow = z.object({
  /**
   * The RECIPIENT row, not the mailout.
   *
   * One mailout can reach the same client several times over — once at their own address and once
   * per company — so the mailout no longer identifies a letter on this tab. The recipient row does.
   */
  id: uuid,
  mailoutId: uuid,
  /** null = it went to the client's own address */
  companyId: uuid.nullable(),
  companyName: z.string().nullable(),
  subject: z.string(),
  templateName: z.string().nullable(),
  kind: mailoutKind,
  status: mailoutStatus,
  reason: z.string().nullable(),
  sentAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ClientMailoutRow = z.infer<typeof clientMailoutRow>;

export const clientMailStateSchema = z.object({
  /** commercial mail only — transactional always sends */
  subscribed: z.boolean(),
  unsubscribedAt: z.iso.datetime().nullable(),
  /** who unsubscribed them; null when the client clicked the link themselves */
  unsubscribedByName: z.string().nullable(),
  /** false when the client card has no email — nothing can be sent to the client themselves */
  hasEmail: z.boolean(),
  /**
   * The addresses this client can be written to, own address first.
   *
   * The card needs it to offer "which of their inboxes", and the module's composer needs the same
   * list — so it is served from the one endpoint that already knows this client, rather than
   * re-derived from the clients list where the emails are not loaded.
   */
  targets: z.array(
    z.object({
      /** null = the client themselves */
      companyId: uuid.nullable(),
      name: z.string(),
      email: z.string().nullable(),
    }),
  ),
  history: z.array(clientMailoutRow),
});
export type ClientMailState = z.infer<typeof clientMailStateSchema>;

/**
 * One letter, as ONE client received it.
 *
 * Its own shape rather than a filter over `mailoutDetailSchema`, because the difference is not
 * cosmetic: this one carries the body rendered with that client's values, and exactly one
 * recipient row. A client's card showing another client's name and address was the bug that made
 * this endpoint exist — a scoped response cannot leak, where a filtered one is one forgotten
 * `.filter()` away from leaking again.
 */
export const clientMailoutDetailSchema = z.object({
  id: uuid,
  mailoutId: uuid,
  /** null = it went to the client's own address; otherwise the company whose inbox it reached */
  companyId: uuid.nullable(),
  companyName: z.string().nullable(),
  subject: z.string(),
  heading: z.string().nullable(),
  /** the letter as THIS client received it — merge variables already substituted */
  body: z.string(),
  templateName: z.string().nullable(),
  kind: mailoutKind,
  sentByName: z.string().nullable(),
  senderName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  status: mailoutStatus,
  reason: z.string().nullable(),
  email: z.string(),
  sentAt: z.iso.datetime().nullable(),
});
export type ClientMailoutDetail = z.infer<typeof clientMailoutDetailSchema>;

/** Re-subscribing is deliberately allowed only from inside the CRM, never from the public link. */
export const setSubscriptionInput = z.object({ subscribed: z.boolean() });
export type SetSubscriptionInput = z.infer<typeof setSubscriptionInput>;

// ── sender mailboxes ─────────────────────────────────────────────────────────

/**
 * A problem found in a mailbox's configuration, reported the moment it is saved rather than
 * discovered from bounced mail.
 *
 * `error` means a real send would fail or break the law; `warning` means it will probably work but
 * is worth knowing. Both are advisory here — the send path enforces its own rules separately,
 * because a check the UI could skip is not a rule.
 */
export const senderCheckSchema = z.object({
  level: z.enum(["error", "warning"]),
  /** which field to point at, when there is one */
  field: z.string().nullable(),
  message: z.string(),
});
export type SenderCheck = z.infer<typeof senderCheckSchema>;

/** Ask a mailbox to prove itself: connect, authenticate, and optionally deliver. */
export const senderTestInput = z.object({
  /** also send a real letter to the signed-in user's own address */
  sendTestLetter: z.boolean().default(false),
});
export type SenderTestInput = z.infer<typeof senderTestInput>;

export const senderTestResult = z.object({
  ok: z.boolean(),
  /** how far it got: connected, or connected AND delivered */
  step: z.enum(["connect", "send"]),
  message: z.string(),
  /** the address a test letter was delivered to, when one was asked for and succeeded */
  sentTo: z.string().nullable(),
});
export type SenderTestResult = z.infer<typeof senderTestResult>;


/**
 * A mailbox the firm sends from.
 *
 * Several, because the letters are not all of a kind: seasonal news from `info@`, invoices from
 * `billing@`. Each carries its own From, its own signature — the block at the foot of the letter
 * names a person, and that differs by mailbox — and its own SMTP credentials.
 *
 * `smtpPass` is write-only: sealed with SECRETS_KEY on the way in, never read back out.
 * `smtpPassSet` says whether one is stored.
 */
export const mailSenderAccountSchema = z.object({
  id: uuid,
  name: z.string(),
  fromName: z.string(),
  fromEmail: z.string().nullable(),
  replyTo: z.string().nullable(),
  signature: z.string().nullable(),
  smtpHost: z.string().nullable(),
  smtpPort: z.number().int().nullable(),
  smtpSecure: z.boolean().nullable(),
  smtpUser: z.string().nullable(),
  smtpPassSet: z.boolean(),
  /** false = borrows the `.env` account that also sends password resets */
  ownSmtp: z.boolean(),
  /** one button each, in this order — empty means no button, never a guess */
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  contactTelegram: z.string().nullable(),
  contactWhatsapp: z.string().nullable(),
  contactViber: z.string().nullable(),
  contactWebsite: z.string().nullable(),
  isDefault: z.boolean(),
  /** the mailbox invoices will go out from once Payments starts sending them */
  isInvoiceSender: z.boolean(),
  active: z.boolean(),
  /** the `From:` header exactly as it will appear, `.env` fallback included */
  effectiveFrom: z.string(),
  /** the SMTP account letters really go over, for display */
  effectiveAccount: z.string(),
  checks: z.array(senderCheckSchema),
});
export type MailSenderAccountDto = z.infer<typeof mailSenderAccountSchema>;

export const mailSenderStateSchema = z.object({
  accounts: z.array(mailSenderAccountSchema),
  /** firm-wide: one firm, one legal address, never per mailbox */
  postalAddress: z.string().nullable(),
  /** the LETTERHEAD mark — its own upload, not the sidebar logo from Settings */
  logo: z.object({ id: uuid, name: z.string() }).nullable(),
  /**
   * The `.env` account — the one that already sends invites and password resets.
   *
   * Top level rather than repeated on each mailbox: it describes the server, not any one of them,
   * and the editor needs it precisely when there are no mailboxes to read it off.
   */
  server: z.object({
    label: z.string(),
    /** the address it is entitled to send as — the one From guaranteed to work untouched */
    fromEmail: z.string(),
  }),
});
export type MailSenderState = z.infer<typeof mailSenderStateSchema>;

const senderText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim() || null)
    .nullable()
    .optional();

export const senderAccountInput = z.object({
  name: z.string().trim().min(1, "Required").max(60).optional(),
  fromName: z.string().trim().max(80).optional(),
  fromEmail: z.union([z.email(), z.literal("")]).optional(),
  replyTo: z.union([z.email(), z.literal("")]).nullable().optional(),
  signature: senderText(2000),
  smtpHost: senderText(200),
  smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
  smtpSecure: z.boolean().nullable().optional(),
  smtpUser: senderText(200),
  /** "" clears the stored password; omit to leave it untouched */
  smtpPass: z.string().max(200).optional(),
  active: z.boolean().optional(),

  // the tap-to-contact buttons — explicit fields, never parsed out of the signature
  contactEmail: z.union([z.email(), z.literal("")]).nullable().optional(),
  contactPhone: senderText(60),
  contactTelegram: senderText(60),
  contactWhatsapp: senderText(60),
  contactViber: senderText(60),
  contactWebsite: senderText(200),
});
export type SenderAccountInput = z.infer<typeof senderAccountInput>;

/** The firm's postal address — its own endpoint, because it belongs to the firm, not a mailbox. */
export const updateFirmMailInput = z.object({
  postalAddress: z
    .string()
    .max(500)
    .transform((v) => v.trim() || null)
    .nullable()
    .optional(),
});
export type UpdateFirmMailInput = z.infer<typeof updateFirmMailInput>;
