/**
 * Client mailouts (S10).
 *
 * ## The one rule everything else follows
 *
 * `commercial` and `transactional` mail are different in law, not in styling. Commercial mail must
 * carry the firm's postal address and a working unsubscribe, and must honour that unsubscribe.
 * Transactional mail — an invoice, a document request — must NOT be silenced by it, because a
 * client who unsubscribed from seasonal news still has to receive their bill. Every branch below
 * that looks at `kind` exists for that reason.
 *
 * ## Nothing is dropped silently
 *
 * A recipient who cannot be sent to is written into the log as `skipped` WITH a reason — no email
 * address, unsubscribed, a `{{variable}}` their card has no value for. A send of 40 that reaches
 * 37 says so, and names the three. The alternative — quietly mailing 37 and reporting success — is
 * how a firm discovers six months later that a client never heard from them.
 *
 * ## Sending happens after the response
 *
 * The rows are written and the request returns; delivery then runs in the background, flipping
 * each row to `sent` or `failed`. A hundred SMTP round-trips cannot happen inside a request. A row
 * still `queued` long after the fact means the process died mid-send — which the log shows
 * honestly, and the firm re-sends to exactly those.
 */
import type { CampaignRhythm, CampaignStatus, MailoutKind } from "@shared/schema/enums.js";
import type { ClientCampaign } from "@shared/schema/campaigns.js";
import type {
  ClientMailoutDetail,
  ClientMailState,
  CreateTemplateInput,
  MailoutDetail,
  MailoutList,
  MailoutListQuery,
  MailoutPreview,
  MailoutPreviewRow,
  MailoutTarget,
  MailSenderAccountDto,
  MailSenderState,
  LetterPreview,
  PreviewLetterInput,
  SenderCheck,
  SenderTestInput,
  SenderTestResult,
  SendMailoutInput,
  SenderAccountInput,
  UpdateFirmMailInput,
  UpdateTemplateInput,
} from "@shared/schema/mailouts.js";
import { mailoutListQuery } from "@shared/schema/mailouts.js";
import {
  renderMailText,
  sampleVars,
  stripMarks,
  usedVariables,
  type MailVars,
} from "@shared/mailouts.js";
import { config } from "../../core/config.js";
import { escapeHtml } from "../../core/html.js";
import {
  envAccount,
  sendRawEmail,
  verifyAccount,
  webOrigin,
  type RawEmail,
  type SmtpAccount,
} from "../../core/email.js";
import { explainSendError } from "../../core/send-error.js";
import {
  applyHighlight,
  LOGO_CID,
  renderLetter,
  renderLetterText,
} from "../../core/email-layout.js";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors.js";
import { deleteFileBytes, readFileBytes, saveFileBytes } from "../../core/files.js";
import { clientLabel, personName } from "../../core/names.js";
import { open, seal, secretsConfigured } from "../../core/secrets-crypto.js";
import type { User } from "../../generated/prisma/client.js";
import * as campaignRepo from "./campaigns.repository.js";
import * as repo from "./mailouts.repository.js";

/** A stored DATE as `YYYY-MM-DD`, read off the UTC-midnight instant days are stored on. */
const isoDay = (d: Date | null) =>
  d
    ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
        .toISOString()
        .slice(0, 10)
    : null;

/** How many of a client's letters the card tab shows. */

type FirmProfile = Awaited<ReturnType<typeof repo.getFirmProfile>>;
type SendableClient = Awaited<ReturnType<typeof repo.findSendableClients>>[number];
type SendableCompany = SendableClient["companies"][number];

/**
 * Who one letter is actually addressed to.
 *
 * A client holds several companies, each with its own inbox, so "the client" was never enough to
 * name an addressee. The company is carried WITH its client rather than instead of it: the
 * address and `{{company}}` come from the company, but who to greet, what the letter may say and
 * whether they have opted out all still belong to the person.
 */
interface Recipient {
  client: SendableClient;
  /** null = the client's own address */
  company: SendableCompany | null;
}

/** The inbox a letter goes to. A company target NEVER falls back to the client's own address. */
function addressOf(r: Recipient): string | null {
  return (r.company ? r.company.email : r.client.email) || null;
}

function companyOf(client: SendableClient, companyId: string | null): SendableCompany | null {
  if (!companyId) return null;
  // matched within the client's OWN companies — one client can never address another's inbox,
  // and that is a property of the lookup rather than a check that could be forgotten
  return client.companies.find((c) => c.id === companyId) ?? null;
}

// ── templates ────────────────────────────────────────────────────────────────

function toTemplate(t: Awaited<ReturnType<typeof repo.findTemplate>> & object) {
  return {
    id: t.id,
    name: t.name,
    subject: t.subject,
    heading: t.heading,
    body: t.body,
    kind: t.kind as MailoutKind,
    active: t.active,
    senderAccountId: t.senderAccountId,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export async function listTemplates() {
  return (await repo.listTemplates()).map(toTemplate);
}

export async function createTemplate(input: CreateTemplateInput) {
  const clash = await repo.findTemplateByName(input.name);
  if (clash) throw new ConflictError(`A template named “${input.name}” already exists`);
  return toTemplate(
    await repo.createTemplate({
      name: input.name,
      subject: input.subject,
      heading: input.heading ?? null,
      body: input.body,
      kind: input.kind,
      senderAccount: input.senderAccountId
        ? { connect: { id: input.senderAccountId } }
        : undefined,
    }),
  );
}

export async function updateTemplate(id: string, input: UpdateTemplateInput) {
  const existing = await repo.findTemplate(id);
  if (!existing) throw new NotFoundError("Template not found");

  if (input.name && input.name.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = await repo.findTemplateByName(input.name);
    if (clash) throw new ConflictError(`A template named “${input.name}” already exists`);
  }
  return toTemplate(await repo.updateTemplate(id, input));
}

export async function deleteTemplate(id: string) {
  const existing = await repo.findTemplate(id);
  if (!existing) throw new NotFoundError("Template not found");

  // A sent mailout keeps a snapshot of its text, but it still points at the template by id for the
  // log's "which template was this" column. Deactivate instead, so history stays readable.
  const scheduled = await repo.countCampaignsForTemplate(id);
  if (scheduled > 0) {
    throw new ConflictError(
      `“${existing.name}” is scheduled by ${scheduled} campaign${scheduled === 1 ? "" : "s"} — change or delete ${scheduled === 1 ? "it" : "them"} first`,
    );
  }

  const used = await repo.countMailoutsForTemplate(id);
  if (used > 0) {
    throw new ConflictError(
      `“${existing.name}” has been used by ${used} mailout${used === 1 ? "" : "s"} — deactivate it instead of deleting`,
    );
  }
  await repo.deleteTemplate(id);
}

// ── sender mailboxes ─────────────────────────────────────────────────────────
//
// A firm sends different kinds of letter from different addresses. Each mailbox carries its own
// From, its own signature — the block at the foot names a PERSON, and that differs by mailbox —
// and its own SMTP credentials. `smtpHost` null means "borrow the `.env` account", so a mailbox
// can be named and used before its own credentials exist.

type SenderAccount = NonNullable<Awaited<ReturnType<typeof repo.findSenderAccount>>>;

function openSmtpPass(account: SenderAccount): string | null {
  if (!account.smtpPass || !account.smtpPassIv || !account.smtpPassTag) return null;
  return open({
    ciphertext: account.smtpPass,
    iv: account.smtpPassIv,
    authTag: account.smtpPassTag,
    keyVersion: account.smtpKeyVersion ?? 1,
  });
}

/** True when this mailbox has credentials of its own rather than borrowing the `.env` account. */
function hasOwnSmtp(account: SenderAccount): boolean {
  return !!account.smtpHost && !!account.smtpPort;
}

function smtpFor(account: SenderAccount): SmtpAccount {
  if (!hasOwnSmtp(account)) return envAccount();
  return {
    host: account.smtpHost!,
    port: account.smtpPort!,
    secure: account.smtpSecure ?? false,
    user: account.smtpUser,
    pass: openSmtpPass(account),
  };
}

/**
 * The `From:` header.
 *
 * `fromEmail` falls back to `MAIL_FROM` because most SMTP servers only send as the address they
 * authenticated — a From the account is not entitled to use is rejected outright, or fails
 * alignment and lands in spam.
 */
function fromHeader(account: SenderAccount): string {
  const address = account.fromEmail?.trim() || config.MAIL_FROM;
  return `"${account.fromName.replace(/"/g, "")}" <${address}>`;
}

/** The mailbox's contact fields, in the shape the letter shell wants. */
function contactsOf(account: SenderAccount) {
  return {
    email: account.contactEmail,
    phone: account.contactPhone,
    telegram: account.contactTelegram,
    whatsapp: account.contactWhatsapp,
    viber: account.contactViber,
    website: account.contactWebsite,
  };
}

const domainOf = (address: string | null) => address?.split("@")[1]?.toLowerCase() ?? null;

/**
 * Everything wrong with one mailbox, found the moment it is saved.
 *
 * The one that matters most is the FROM MISMATCH. Almost every SMTP server refuses to send as an
 * address it did not authenticate; the ones that allow it produce mail that fails SPF and DKIM
 * alignment and lands in spam. Neither failure is visible in development, because Mailpit accepts
 * anything — it appears for the first time on the server, on the first real mailout.
 *
 * Advisory: the send path enforces its own rules separately. A check the UI could skip is not a
 * rule; this list exists to explain, early, what the send path would do.
 */
function accountChecks(account: SenderAccount, firm: FirmProfile): SenderCheck[] {
  const checks: SenderCheck[] = [];
  const own = hasOwnSmtp(account);
  const from = account.fromEmail?.trim() || config.MAIL_FROM;
  const authUser = own ? account.smtpUser : config.SMTP_USER || null;

  if (!account.fromEmail?.trim()) {
    checks.push({
      level: "error",
      field: "fromEmail",
      message: `No From address, so letters would go out as ${config.MAIL_FROM}.`,
    });
  }
  if (account.smtpHost && !account.smtpPort) {
    checks.push({ level: "error", field: "smtpPort", message: "An SMTP host but no port." });
  }
  if (own && !account.smtpUser) {
    checks.push({
      level: "error",
      field: "smtpUser",
      message: "No username, so this mailbox cannot authenticate.",
    });
  }
  if (own && account.smtpUser && !account.smtpPass) {
    checks.push({
      level: "error",
      field: "smtpPass",
      message: "No password stored. Enter it and save.",
    });
  }

  if (authUser && from && authUser.toLowerCase() !== from.toLowerCase()) {
    const sameDomain = domainOf(authUser) === domainOf(from);
    checks.push({
      level: sameDomain ? "warning" : "error",
      field: "fromEmail",
      message: sameDomain
        ? `Sends as ${from} over the account ${authUser}. Many servers refuse to send as an address they did not authenticate — run the test.`
        : `Would claim to be ${from} while authenticating as ${authUser}, on a different domain. Most servers reject that, and the rest produce mail that fails SPF and DKIM. Either send as ${authUser}, or give this mailbox the credentials for ${from}.`,
    });
  }

  // A `noreply@` From with no Reply-to is a letter a client cannot answer. It fails in the worst
  // possible way — silently: the client believes they replied, and the firm never hears it.
  if (from && /^(no-?reply|donotreply|do-not-reply)@/i.test(from) && !account.replyTo?.trim()) {
    checks.push({
      level: "warning",
      field: "replyTo",
      message: `Sends as ${from} with no Reply-to, so a client who answers a letter reaches nobody. Name the inbox their replies should land in.`,
    });
  }

  if (!account.signature?.trim()) {
    checks.push({
      level: "warning",
      field: "signature",
      message: "No signature, so letters from here carry no contact block and no buttons.",
    });
  }
  if (!own) {
    checks.push({
      level: "warning",
      field: "smtpHost",
      message:
        "Borrows the server's own mail account — the one that sends password resets. A spam complaint here would damage the address your team needs to sign in.",
    });
  }
  // firm-wide, but it blocks sending from every mailbox, so it belongs on each card
  if (!firm.postalAddress?.trim()) {
    checks.push({
      level: "error",
      field: "postalAddress",
      message:
        "The firm has no postal address, so commercial mailouts are refused from any mailbox.",
    });
  }

  return checks.sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
}

function toSenderAccount(account: SenderAccount, firm: FirmProfile): MailSenderAccountDto {
  return {
    id: account.id,
    name: account.name,
    fromName: account.fromName,
    fromEmail: account.fromEmail || null,
    replyTo: account.replyTo,
    signature: account.signature,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpSecure: account.smtpSecure,
    smtpUser: account.smtpUser,
    smtpPassSet: !!account.smtpPass,
    ownSmtp: hasOwnSmtp(account),
    contactEmail: account.contactEmail,
    contactPhone: account.contactPhone,
    contactTelegram: account.contactTelegram,
    contactWhatsapp: account.contactWhatsapp,
    contactViber: account.contactViber,
    contactWebsite: account.contactWebsite,
    isDefault: account.isDefault,
    isInvoiceSender: account.isInvoiceSender,
    active: account.active,
    effectiveFrom: fromHeader(account),
    effectiveAccount: hasOwnSmtp(account)
      ? `${account.smtpHost}:${account.smtpPort}${account.smtpUser ? ` as ${account.smtpUser}` : ""}`
      : `${config.SMTP_HOST}:${config.SMTP_PORT} (the server's own mailbox)`,
    checks: accountChecks(account, firm),
  };
}

export async function listSenderAccounts(): Promise<MailSenderState> {
  const [accounts, firm] = await Promise.all([
    repo.listSenderAccounts(),
    repo.getFirmProfile(),
  ]);
  return {
    accounts: accounts.map((a) => toSenderAccount(a, firm)),
    postalAddress: firm.postalAddress,
    logo: firm.mailLogoFile ? { id: firm.mailLogoFile.id, name: firm.mailLogoFile.name } : null,
    server: {
      label: `${config.SMTP_HOST}:${config.SMTP_PORT}${config.SMTP_USER ? ` as ${config.SMTP_USER}` : ""}`,
      fromEmail: config.MAIL_FROM,
    },
  };
}

/** The firm's postal address — one address, not per mailbox, so it is saved on its own. */
export async function updateFirmMail(input: UpdateFirmMailInput): Promise<MailSenderState> {
  await repo.updateFirmProfile({ postalAddress: input.postalAddress ?? null });
  return listSenderAccounts();
}

/** Accepted letterhead formats. SVG is refused: mail clients do not render it. */
const MAIL_LOGO_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_MAIL_LOGO = 2 * 1024 * 1024;

/**
 * The mark that goes in letters, uploaded here rather than borrowed from Settings.
 *
 * Its own file because the two logos have different jobs: the sidebar mark is small, sits on a
 * dark panel and can be any shape; this one is 168px wide on white and wants a tight crop at the
 * lockup's aspect. Sharing one file means a firm that restyles its app silently restyles what its
 * clients receive.
 */
export async function setMailLogo(
  actor: User,
  file: { buffer: Buffer; filename: string; mimetype: string },
): Promise<MailSenderState> {
  if (!MAIL_LOGO_MIME.includes(file.mimetype)) {
    throw new ValidationError(
      "The letterhead must be a PNG, JPEG, WebP or GIF. SVG is not accepted — mail clients do not render it.",
    );
  }
  if (file.buffer.byteLength > MAX_MAIL_LOGO) {
    throw new ValidationError("The letterhead must be 2 MB or smaller");
  }

  const firm = await repo.getFirmProfile();
  const relPath = await saveFileBytes(file.buffer, file.filename);
  const row = await repo.createFileRow({
    name: file.filename,
    size: file.buffer.byteLength,
    mime: file.mimetype,
    path: relPath,
    uploadedById: actor.id,
  });
  await repo.updateFirmProfile({ mailLogoFile: { connect: { id: row.id } } });

  // the replaced file is dropped only after the new one is safely pointed at
  if (firm.mailLogoFile) {
    await repo.deleteFileRow(firm.mailLogoFile.id).catch(() => {});
    await deleteFileBytes(firm.mailLogoFile.path).catch(() => {});
  }
  return listSenderAccounts();
}

export async function getMailLogoFile() {
  const firm = await repo.getFirmProfile();
  if (!firm.mailLogoFile) throw new NotFoundError("No letterhead has been uploaded");
  return firm.mailLogoFile;
}

export async function removeMailLogo(): Promise<MailSenderState> {
  const firm = await repo.getFirmProfile();
  if (firm.mailLogoFile) {
    await repo.updateFirmProfile({ mailLogoFile: { disconnect: true } });
    await repo.deleteFileRow(firm.mailLogoFile.id).catch(() => {});
    await deleteFileBytes(firm.mailLogoFile.path).catch(() => {});
  }
  return listSenderAccounts();
}

function sealPassword(password: string) {
  if (!secretsConfigured()) {
    throw new ValidationError(
      "SECRETS_KEY is not configured — an SMTP password cannot be stored safely without it",
    );
  }
  const sealed = seal(password);
  return {
    smtpPass: sealed.ciphertext,
    smtpPassIv: sealed.iv,
    smtpPassTag: sealed.authTag,
    smtpKeyVersion: sealed.keyVersion,
  };
}

function accountWrite(input: SenderAccountInput) {
  const data: Record<string, unknown> = {};
  const blank = (v: string | null | undefined) =>
    v === undefined ? undefined : v?.trim() || null;

  if (input.name !== undefined) data.name = input.name.trim();
  if (input.fromName !== undefined) data.fromName = input.fromName.trim();
  if (input.fromEmail !== undefined) data.fromEmail = input.fromEmail.trim();
  if (input.replyTo !== undefined) data.replyTo = blank(input.replyTo);
  if (input.signature !== undefined) data.signature = blank(input.signature);
  if (input.smtpHost !== undefined) data.smtpHost = blank(input.smtpHost);
  if (input.smtpPort !== undefined) data.smtpPort = input.smtpPort ?? null;
  if (input.smtpSecure !== undefined) data.smtpSecure = input.smtpSecure ?? null;
  if (input.smtpUser !== undefined) data.smtpUser = blank(input.smtpUser);
  if (input.active !== undefined) data.active = input.active;
  for (const key of ["Email", "Phone", "Telegram", "Whatsapp", "Viber", "Website"] as const) {
    const field = `contact${key}` as const;
    if (input[field] !== undefined) data[field] = blank(input[field]);
  }

  // "" clears a stored password; omitted leaves it alone, so saving the rest never wipes it
  if (input.smtpPass !== undefined) {
    Object.assign(
      data,
      input.smtpPass
        ? sealPassword(input.smtpPass)
        : { smtpPass: null, smtpPassIv: null, smtpPassTag: null, smtpKeyVersion: null },
    );
  }
  return data;
}

export async function createSenderAccount(input: SenderAccountInput): Promise<MailSenderState> {
  if (!input.name?.trim()) throw new ValidationError("Give the mailbox a name");
  const clash = await repo.findSenderAccountByName(input.name);
  if (clash) throw new ConflictError(`A mailbox named “${input.name.trim()}” already exists`);

  const first = (await repo.countSenderAccounts()) === 0;
  const created = await repo.createSenderAccount({
    name: input.name.trim(),
    fromName: input.fromName?.trim() || input.name.trim(),
    fromEmail: input.fromEmail?.trim() || "",
    ...accountWrite({ ...input, name: undefined, fromName: undefined, fromEmail: undefined }),
    // the very first mailbox becomes the default: a firm should never be one save away from
    // having mailboxes but no default, which is a state the send path cannot resolve
    isDefault: first,
  } as never);
  if (first) await repo.makeSenderAccountDefault(created.id);
  return listSenderAccounts();
}

export async function updateSenderAccount(
  id: string,
  input: SenderAccountInput,
): Promise<MailSenderState> {
  const existing = await repo.findSenderAccount(id);
  if (!existing) throw new NotFoundError("Mailbox not found");

  if (input.name && input.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
    const clash = await repo.findSenderAccountByName(input.name);
    if (clash) throw new ConflictError(`A mailbox named “${input.name.trim()}” already exists`);
  }
  // The default must stay sendable — deactivating it would leave every send without a fallback.
  if (input.active === false && existing.isDefault) {
    throw new ConflictError("Make another mailbox the default before deactivating this one");
  }

  await repo.updateSenderAccount(id, accountWrite(input) as never);
  return listSenderAccounts();
}

export async function makeSenderAccountDefault(id: string): Promise<MailSenderState> {
  const account = await repo.findSenderAccount(id);
  if (!account) throw new NotFoundError("Mailbox not found");
  if (!account.active)
    throw new ValidationError("Activate the mailbox before making it default");
  await repo.makeSenderAccountDefault(id);
  return listSenderAccounts();
}

/**
 * Point invoices at a mailbox.
 *
 * Stored now, used later: when Payments starts emailing invoices it reads this instead of growing
 * a second, competing setting of its own. That is the whole reason it exists before the feature
 * that consumes it.
 */
export async function makeInvoiceSender(id: string): Promise<MailSenderState> {
  const account = await repo.findSenderAccount(id);
  if (!account) throw new NotFoundError("Mailbox not found");
  if (!account.active) throw new ValidationError("Activate the mailbox first");
  await repo.makeInvoiceSender(id);
  return listSenderAccounts();
}

export async function deleteSenderAccount(id: string): Promise<MailSenderState> {
  const account = await repo.findSenderAccount(id);
  if (!account) throw new NotFoundError("Mailbox not found");
  if (account.isDefault) throw new ConflictError("The default mailbox cannot be deleted");

  // History points at accounts. A letter whose mailbox has vanished can no longer answer "where
  // did this come from" — so anything referenced is deactivated, never removed.
  const [mailouts, templates] = await repo.countSenderAccountUsage(id);
  if (mailouts || templates) {
    const parts = [
      mailouts ? `${mailouts} mailout${mailouts === 1 ? "" : "s"}` : null,
      templates ? `${templates} template${templates === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    throw new ConflictError(
      `“${account.name}” is used by ${parts.join(" and ")} — deactivate it instead of deleting`,
    );
  }
  await repo.deleteSenderAccount(id);
  return listSenderAccounts();
}

/**
 * Which mailbox a send goes from: the one it names, else the template's, else the default.
 *
 * Throws rather than silently picking one — a letter leaving from a mailbox nobody chose is how a
 * client gets a reply-to nobody reads.
 */
async function resolveSenderAccount(
  explicitId: string | null | undefined,
  templateAccountId: string | null,
): Promise<SenderAccount> {
  const wanted = explicitId ?? templateAccountId;
  if (wanted) {
    const account = await repo.findSenderAccount(wanted);
    if (!account) throw new NotFoundError("That sender mailbox no longer exists");
    if (!account.active) throw new ValidationError(`“${account.name}” is deactivated`);
    return account;
  }
  const fallback = await repo.findDefaultSenderAccount();
  if (!fallback) {
    throw new ValidationError("No sender mailbox is set up — add one under Mailouts → Sender");
  }
  return fallback;
}

/**
 * Make a mailbox prove itself — connect, authenticate, and optionally deliver a real letter.
 *
 * String comparison catches one class of mistake; only a handshake catches a wrong password, a
 * firewall, a wrong port, or a server that refuses the From. This is the difference between
 * believing the settings are right and knowing.
 */
export async function testSenderAccount(
  actor: User,
  id: string,
  input: SenderTestInput,
): Promise<SenderTestResult> {
  const account = await repo.findSenderAccount(id);
  if (!account) throw new NotFoundError("Mailbox not found");
  const firm = await repo.getFirmProfile();

  let smtp: SmtpAccount;
  try {
    smtp = smtpFor(account);
  } catch (err) {
    return {
      ok: false,
      step: "connect",
      message: `Could not read the stored password: ${err instanceof Error ? err.message : String(err)}`,
      sentTo: null,
    };
  }

  try {
    await verifyAccount(smtp);
  } catch (err) {
    // The whole point of a test button is to hand back an instruction, not a diagnosis. The same
    // translator the delivery log uses runs here, so a wrong password reads the same way in both
    // places — and the raw text stays in the server log for whoever needs the protocol detail.
    console.error(`[mailouts] test connect failed for account=${id}:`, err);
    return {
      ok: false,
      step: "connect",
      message: explainSendError(err, { host: smtp.host, port: smtp.port }).message,
      sentTo: null,
    };
  }

  if (!input.sendTestLetter) {
    return {
      ok: true,
      step: "connect",
      message: `Connected and signed in to ${smtp.host}:${smtp.port}.`,
      sentTo: null,
    };
  }
  if (!actor.email) {
    return {
      ok: false,
      step: "send",
      message: "Your account has no email address.",
      sentTo: null,
    };
  }

  const logo = await loadLogo(firm);
  const shell = {
    heading: "This is a test letter",
    body:
      `If you are reading this, the “${account.name}” mailbox is working.\n\n` +
      `Sent as ${fromHeader(account)} over ${smtp.host}:${smtp.port}.\n\n` +
      `Check the sender name, that the buttons below open the right places, and — on the real ` +
      `server — that this did not land in spam.`,
    firmName: account.fromName,
    signature: account.signature,
    contacts: contactsOf(account),
    postalAddress: firm.postalAddress,
    unsubscribeUrl: null, // a test is not commercial mail; nobody should unsubscribe from it
    logoSrc: cidSrc(logo),
  };

  try {
    await sendRawEmail({
      to: actor.email,
      subject: `Test letter from ${account.fromName}`,
      html: renderLetter(shell),
      text: renderLetterText(shell),
      from: fromHeader(account),
      replyTo: account.replyTo,
      account: smtp,
      attachments: logo ? [{ ...logo, cid: LOGO_CID }] : undefined,
    });
  } catch (err) {
    console.error(`[mailouts] test send failed for account=${id}:`, err);
    return {
      ok: false,
      step: "send",
      message: `Signed in, but the letter did not go. ${explainSendError(err, { host: smtp.host, port: smtp.port }).message}`,
      sentTo: null,
    };
  }

  return {
    ok: true,
    step: "send",
    message: `Sent. Check ${actor.email} — including the spam folder, which is where a From the server dislikes will land it.`,
    sentTo: actor.email,
  };
}

// ── rendering one letter ─────────────────────────────────────────────────────

function varsFor({ client, company }: Recipient, account: SenderAccount): MailVars {
  return {
    first_name: client.firstName,
    last_name: client.lastName,
    full_name: clientLabel(client),
    // A letter sent TO a company is about that company: `{{company}}` must name the one being
    // written to, not the informational "trades as" label on the client card.
    company: company ? company.name : client.companyName,
    email: addressOf({ client, company }),
    // the company's own line when it has one — a letter to the business should not print the
    // owner's personal number
    phone: company?.phone || client.phone,
    // companies carry no postal address of their own; the client's is the firm's only record
    address: client.address,
    firm_name: account.fromName,
    firm_email: account.fromEmail?.trim() || config.MAIL_FROM,
  };
}

interface Letter {
  subject: string;
  heading: string | null;
  body: string;
  kind: MailoutKind;
  templateId: string | null;
  /** the mailbox this template usually goes from; a send may override it */
  senderAccountId: string | null;
}

/**
 * The one-click unsubscribe endpoint (RFC 8058).
 *
 * A GET on this URL shows a confirmation page; only a POST actually unsubscribes. That split is
 * not ceremony: corporate mail scanners follow every link in an incoming message, and a GET that
 * mutated would unsubscribe clients who never opened the letter.
 */
function unsubscribeUrl(token: string, fromMailoutId: string | null = null): string {
  const base = `${webOrigin()}/api/mailouts/unsubscribe/${token}`;
  // The letter's own id, so an opt-out can name what prompted it — "unsubscribed from the March
  // newsletter" rather than just "unsubscribed". The token belongs to the CLIENT and is the same
  // in every letter they ever get, so it cannot answer that on its own.
  //
  // A URL is a claim, not proof: anyone can edit one. The server stores this only after checking
  // that the mailout really did write to that client — see `unsubscribeByToken`.
  return fromMailoutId ? `${base}?m=${fromMailoutId}` : base;
}

function buildEmail(
  letter: Letter,
  recipient: Recipient,
  account: SenderAccount,
  firm: FirmProfile,
  token: string | null,
  /** stamped into the unsubscribe link so an opt-out can say which letter prompted it */
  mailoutId: string | null,
  /**
   * How the masthead image is referenced — NOT derived here.
   *
   * A real send points at its own attachment with `cid:`; a browser preview has no attachment and
   * must inline the bytes. This function is called by both, so a default would be right for one of
   * them and a broken image for the other — which is exactly what happened.
   */
  logoSrc: string | null,
): { subject: string; html: string; text: string; headers: Record<string, string> } {
  const vars = varsFor(recipient, account);
  const subject = renderMailText(letter.subject, vars).text;
  const heading = letter.heading ? renderMailText(letter.heading, vars).text : subject;
  const body = renderMailText(letter.body, vars).text;
  const commercial = letter.kind === "commercial";
  const unsub = commercial && token ? unsubscribeUrl(token, mailoutId) : null;

  const shell = {
    heading,
    body,
    firmName: account.fromName,
    signature: account.signature,
    contacts: contactsOf(account),
    postalAddress: commercial ? firm.postalAddress : null,
    unsubscribeUrl: unsub,
    logoSrc,
  };

  const headers: Record<string, string> = {};
  if (unsub) {
    // Gmail and Yahoo require these of bulk senders; without them commercial mail is
    // increasingly refused outright rather than merely filtered.
    headers["List-Unsubscribe"] = `<${unsub}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  return { subject, html: renderLetter(shell), text: renderLetterText(shell), headers };
}

async function loadLogo(firm: FirmProfile) {
  if (!firm.mailLogoFile) return null;
  try {
    return {
      content: await readFileBytes(firm.mailLogoFile.path),
      filename: firm.mailLogoFile.name,
      contentType: firm.mailLogoFile.mime,
    };
  } catch {
    // a missing file on disk must not stop a mailout — the shell falls back to the wordmark
    return null;
  }
}

/**
 * How the masthead image is referenced, which is NOT the same for the two callers.
 *
 * A delivered letter carries the image as an attachment and points at it with `cid:`. A browser
 * preview has no attachment, so the same `cid:` is a dead reference and renders as a broken-image
 * icon — which is exactly what the preview did until this was split.
 */
const cidSrc = (logo: unknown) => (logo ? `cid:${LOGO_CID}` : null);

function dataSrc(logo: { content: Buffer; contentType: string } | null): string | null {
  return logo ? `data:${logo.contentType};base64,${logo.content.toString("base64")}` : null;
}

// ── deciding who gets it ─────────────────────────────────────────────────────

interface Decision {
  clientId: string;
  /** null = the client's own address */
  companyId: string | null;
  clientName: string;
  companyName: string | null;
  email: string | null;
  subject: string;
  /** null = will be sent */
  blockedReason: string | null;
  /** the CLIENT's unsubscribe token — one opt-out covers every address of theirs */
  token: string | null;
}

async function resolveLetter(input: SendMailoutInput): Promise<Letter> {
  if (input.templateId) {
    const t = await repo.findTemplate(input.templateId);
    if (!t) throw new NotFoundError("Template not found");
    if (!t.active) throw new ValidationError(`“${t.name}” is inactive — activate it to send`);
    return {
      subject: t.subject,
      heading: t.heading,
      body: t.body,
      kind: t.kind as MailoutKind,
      templateId: t.id,
      senderAccountId: t.senderAccountId,
    };
  }
  const l = input.letter!;
  return {
    subject: l.subject,
    heading: l.heading ?? null,
    body: l.body,
    kind: l.kind,
    templateId: null,
    senderAccountId: null,
  };
}

/**
 * Collapse the asked-for targets to one row per addressee.
 *
 * The same client, or the same company, named twice would collide on the table's uniqueness and
 * fail the WHOLE send with a database error — one careless caller costing forty letters. Answered
 * here instead, where "you asked twice, they get one letter" is plainly what was meant. Order is
 * preserved so the preview lists people in the order they were picked.
 */
function dedupeTargets(
  targets: MailoutTarget[],
): { clientId: string; companyId: string | null }[] {
  const seen = new Map<string, { clientId: string; companyId: string | null }>();
  for (const t of targets) {
    const companyId = t.companyId ?? null;
    const key = `${t.clientId}:${companyId ?? ""}`;
    if (!seen.has(key)) seen.set(key, { clientId: t.clientId, companyId });
  }
  return [...seen.values()];
}

/**
 * Walk the chosen addressees and decide each one's fate, in the order the reasons matter: an
 * addressee with no address cannot be told anything, an unsubscribed client must not be, and a
 * client whose card is missing a value the letter needs would get a sentence with a hole in it.
 *
 * Two things about companies are deliberate. A company with no email of its own is **skipped with
 * a reason**, never quietly redirected to the client's inbox — somebody chose that company, and
 * silently mailing a person instead of their business is the kind of "help" that ends up in the
 * wrong hands. And the unsubscribe check is the CLIENT's, so one opt-out covers their own address
 * and every company they hold: the stricter reading, and the one a regulator would take.
 */
/**
 * One addressee's fate, decided from data already in hand.
 *
 * Pulled out of `decide` so the same rule can be asked about one client against several letters
 * without re-loading that client, their companies and their consent once per letter — which is
 * what the client card did, up to fifty times, on a screen that refetches whenever the window
 * regains focus. One rule, two callers, no second copy to drift.
 */
function judge(
  letter: Letter,
  client: SendableClient,
  companyId: string | null,
  account: SenderAccount,
): { decision: Decision; unknown: string[] } {
  const company = companyOf(client, companyId);
  if (companyId && !company) {
    return {
      decision: {
        clientId: client.id,
        companyId,
        clientName: clientLabel(client),
        companyName: null,
        email: null,
        subject: letter.subject,
        blockedReason: "That company is no longer on this client's card",
        token: null,
      },
      unknown: [],
    };
  }

  const recipient: Recipient = { client, company };
  const email = addressOf(recipient);
  const vars = varsFor(recipient, account);
  const subject = renderMailText(letter.subject, vars);
  const body = renderMailText(letter.body, vars);
  const heading = renderMailText(letter.heading ?? "", vars);
  const missing = [...new Set([...subject.missing, ...body.missing, ...heading.missing])];

  // In the order the reasons matter: an addressee with no address cannot be told anything, an
  // unsubscribed client must not be, and a card missing a value the letter needs would produce a
  // sentence with a hole in it.
  let blockedReason: string | null = null;
  if (!email) {
    blockedReason = company
      ? `No email address on ${company.name}`
      : "No email address on the client card";
  } else if (letter.kind === "commercial" && client.mailPreference?.unsubscribedAt) {
    blockedReason = "Unsubscribed from commercial mail";
  } else if (missing.length) {
    blockedReason = `Client card has no ${missing.map((m) => `{{${m}}}`).join(", ")}`;
  }

  return {
    decision: {
      clientId: client.id,
      companyId,
      clientName: clientLabel(client),
      companyName: company?.name ?? null,
      email,
      subject: subject.text,
      blockedReason,
      token: client.mailPreference?.token ?? null,
    },
    unknown: [...subject.unknown, ...body.unknown, ...heading.unknown],
  };
}

async function decide(
  letter: Letter,
  targets: MailoutTarget[],
  account: SenderAccount,
): Promise<{
  decisions: Decision[];
  unknownVariables: string[];
  /** the loaded clients, so callers that need to render one do not fetch them a second time */
  clients: Map<string, SendableClient>;
}> {
  const wanted = dedupeTargets(targets);
  const loaded = await repo.findSendableClients([...new Set(wanted.map((t) => t.clientId))]);
  const byId = new Map(loaded.map((c) => [c.id, c]));
  const unknown = new Set<string>();
  const decisions: Decision[] = [];

  for (const { clientId, companyId } of wanted) {
    const client = byId.get(clientId);
    if (!client) {
      decisions.push({
        clientId,
        companyId,
        clientName: "—",
        companyName: null,
        email: null,
        subject: letter.subject,
        blockedReason: "Archived or no longer exists",
        token: null,
      });
      continue;
    }
    const { decision, unknown: u } = judge(letter, client, companyId, account);
    for (const v of u) unknown.add(v);
    decisions.push(decision);
  }

  return { decisions, unknownVariables: [...unknown], clients: byId };
}

/**
 * Commercial mail without the firm's postal address is unlawful in the US, so it is refused at the
 * boundary rather than sent and apologised for. Transactional mail is exempt and unaffected.
 */
function assertSendable(letter: Letter, firm: FirmProfile) {
  if (letter.kind === "commercial" && !firm.postalAddress?.trim()) {
    throw new ValidationError(
      "Add the firm's postal address in Settings → Mailouts. US law (CAN-SPAM) requires it in " +
        "every commercial email. Transactional letters are exempt.",
    );
  }
}

// ── preview ──────────────────────────────────────────────────────────────────

/**
 * The letter as a letter — full brand shell, sample values, no recipients.
 *
 * Answers "what does this look like", which the composer's preview cannot: that one needs clients
 * chosen first, and having to pick a recipient before you may look at your own layout is the wrong
 * shape for the question. It also reports up front whether a commercial send would be refused for
 * want of a postal address, rather than letting the firm discover that at the end of a send flow.
 */
export async function previewLetter(input: PreviewLetterInput): Promise<LetterPreview> {
  const firm = await repo.getFirmProfile();
  // Previewed through the mailbox it would go from — the signature and the sender's name differ
  // per mailbox, so a preview against "the firm" would show a letter no mailbox produces.
  const account = await resolveSenderAccount(input.senderAccountId, null);
  const vars = {
    ...sampleVars(),
    firm_name: account.fromName,
    firm_email: account.fromEmail?.trim() || config.MAIL_FROM,
  };

  // Rendered ONCE, with the substituted values fenced. The two htmls below differ only in whether
  // those fences become a highlight or vanish — so flipping the toggle cannot show a letter
  // assembled differently from the one being described.
  const marked = { mark: true } as const;
  const subject = renderMailText(input.subject, vars, marked);
  const heading = renderMailText(input.heading || input.subject, vars, marked);
  const body = renderMailText(input.body, vars, marked);
  const commercial = input.kind === "commercial";

  const shell = {
    heading: heading.text,
    body: body.text,
    firmName: account.fromName,
    signature: account.signature,
    contacts: contactsOf(account),
    postalAddress: commercial ? firm.postalAddress : null,
    unsubscribeUrl: commercial ? unsubscribeUrl("sample-token", null) : null,
    logoSrc: dataSrc(await loadLogo(firm)),
  };
  const html = renderLetter(shell);

  let blockedReason: string | null = null;
  if (commercial && !firm.postalAddress?.trim()) {
    blockedReason =
      "Add the firm's postal address in Sender — US law requires it in commercial email.";
  }

  return {
    subject: stripMarks(subject.text),
    html: applyHighlight(html, false),
    highlightedHtml: applyHighlight(html, true),
    /** what the highlight is pointing at, so the legend names the same thing the colour marks */
    variablesUsed: usedVariables(input.subject, input.heading, input.body),
    unknownVariables: [...new Set([...subject.unknown, ...heading.unknown, ...body.unknown])],
    sendable: !blockedReason,
    blockedReason,
  };
}

export async function preview(input: SendMailoutInput): Promise<MailoutPreview> {
  const letter = await resolveLetter(input);
  const account = await resolveSenderAccount(input.senderAccountId, letter.senderAccountId);
  const { decisions, unknownVariables } = await decide(letter, input.recipients, account);

  // The subject as the first addressee who will actually receive it reads it — quoting a blocked
  // one would show exactly the letter the send is about to refuse. The company matters here as
  // much as the client: `{{company}}` names a different business in each.
  //
  // No shell is rendered and no logo is read from disk: this step answers "who", not "what does it
  // look like", and building a full letter nobody displays is work on every check.
  const shown = decisions.find((d) => !d.blockedReason) ?? decisions[0];

  const rows: MailoutPreviewRow[] = decisions.map((d) => ({
    clientId: d.clientId,
    companyId: d.companyId,
    clientName: d.clientName,
    companyName: d.companyName,
    email: d.email,
    subject: d.subject,
    blockedReason: d.blockedReason,
  }));

  return {
    subject: shown.subject,
    rows,
    sendable: rows.filter((r) => !r.blockedReason).length,
    blocked: rows.filter((r) => r.blockedReason).length,
    unknownVariables,
    senderAccountId: account.id,
    senderAccountName: account.name,
    senderFrom: fromHeader(account),
  };
}

// ── send ─────────────────────────────────────────────────────────────────────

/** Who or what caused a send — a person at the composer, or a campaign whose date came round. */
export interface Provenance {
  actorId: string | null;
  campaignId: string | null;
  /** which of the campaign's dates, `YYYY-MM-DD`. The unique key that makes a double run fail. */
  periodKey: string | null;
}

/**
 * Write the rows, then start delivering. **The one send path.**
 *
 * A person pressing Send and a campaign's date arriving differ in exactly two things: who to
 * record as the cause, and whether an empty list is an error. Everything else — the addressee
 * decisions, the unsubscribe tokens, the snapshot, the background delivery — is identical, and
 * keeping it identical is the point. A second path that only nearly matched is how the two would
 * drift until a scheduled letter quietly stopped honouring an opt-out.
 *
 * Never throws on "nobody is reachable": that judgement belongs to the caller. The composer
 * refuses it, because a person is standing there and can fix the list; a campaign records the run
 * with every row skipped and its reason, because the occurrence happened and pretending otherwise
 * would make it fire again tomorrow, and the day after.
 */
async function dispatch(
  letter: Letter,
  account: SenderAccount,
  firm: FirmProfile,
  targets: MailoutTarget[],
  provenance: Provenance,
  /** forced onto every row, whatever the addressee's own state — see `runCampaign` */
  blockAllBecause: string | null = null,
): Promise<string> {
  const { decisions } = await decide(letter, targets, account);
  for (const d of decisions) if (blockAllBecause) d.blockedReason = blockAllBecause;
  const going = decisions.filter((d) => !d.blockedReason);

  // Everyone actually being mailed needs a stable unsubscribe token before the letter is built,
  // since the token goes inside it. Minted for the whole batch at once — see the repository.
  //
  // Distinct CLIENTS, not rows: a client written to at three of their companies has one token,
  // because one click must take all three addresses off the list. Passing the row list instead
  // would ask the database to insert the same client three times.
  if (letter.kind === "commercial" && going.length > 0) {
    const tokens = await repo.ensureMailPreferences([...new Set(going.map((d) => d.clientId))]);
    for (const d of going) d.token = tokens.get(d.clientId) ?? d.token;
  }

  const mailout = await repo.createMailout(
    {
      subject: letter.subject,
      heading: letter.heading,
      body: letter.body,
      kind: letter.kind,
      template: letter.templateId ? { connect: { id: letter.templateId } } : undefined,
      senderAccount: { connect: { id: account.id } },
      createdBy: provenance.actorId ? { connect: { id: provenance.actorId } } : undefined,
      campaign: provenance.campaignId ? { connect: { id: provenance.campaignId } } : undefined,
      periodKey: provenance.periodKey,
    },
    decisions.map((d) => ({
      clientId: d.clientId,
      companyId: d.companyId,
      email: d.email ?? "",
      status: d.blockedReason ? ("skipped" as const) : ("queued" as const),
      reason: d.blockedReason,
    })),
  );

  // Deliver after the response. `void` is the point: a hundred SMTP round-trips cannot happen
  // inside a request, and the log is what reports the outcome.
  if (going.length > 0) {
    void deliver(mailout.id, letter, account, firm).catch((err) => {
      console.error(`[mailouts] delivery run failed for mailout=${mailout.id}:`, err);
    });
  }
  return mailout.id;
}

export async function send(actor: User, input: SendMailoutInput): Promise<MailoutDetail> {
  const firm = await repo.getFirmProfile();
  const letter = await resolveLetter(input);
  const account = await resolveSenderAccount(input.senderAccountId, letter.senderAccountId);
  assertSendable(letter, firm);

  // Checked BEFORE any row is written: a person is standing at the composer and can fix the list,
  // so an empty send is a refusal to their face rather than a log entry they may never open.
  const { decisions } = await decide(letter, input.recipients, account);
  if (decisions.every((d) => d.blockedReason)) {
    throw new ValidationError(
      "Nobody on this list can be sent to — see the reasons beside each name",
    );
  }

  const id = await dispatch(letter, account, firm, input.recipients, {
    actorId: actor.id,
    campaignId: null,
    periodKey: null,
  });
  return detail(id);
}

// ── what a campaign needs from the send path ─────────────────────────────────
//
// Exported here rather than re-implemented next door: a campaign IS a mailout with a date, and the
// moment it grows its own copy of "who can be written to" the two start drifting.

/**
 * What would happen to ONE client under several planned letters, in a fixed number of queries.
 *
 * The client card lists every campaign a client is on and says, per campaign, whether they would
 * actually be reached. Asking `assessTargets` once per campaign re-read that client, their
 * companies, their consent, the template and the mailbox every time — up to fifty rounds of five
 * queries on a screen that refetches whenever the window regains focus.
 *
 * Here the client is loaded once, the templates in one query, and each distinct mailbox once.
 * The rule itself is `judge`, the same one a real send goes through.
 */
export async function assessClientPlans(
  clientId: string,
  plans: {
    templateId: string;
    kind: MailoutKind;
    senderAccountId: string | null;
    companyId: string | null;
  }[],
): Promise<(string | null)[]> {
  if (plans.length === 0) return [];

  const [clients, templates] = await Promise.all([
    repo.findSendableClients([clientId]),
    repo.findTemplatesByIds([...new Set(plans.map((p) => p.templateId))]),
  ]);
  const client = clients[0];
  if (!client) return plans.map(() => "Archived or no longer exists");
  const byTemplate = new Map(templates.map((t) => [t.id, t]));

  // one lookup per distinct mailbox, not per plan — most firms have one
  const accounts = new Map<string, SenderAccount>();
  const accountFor = async (chosen: string | null, templateDefault: string | null) => {
    const key = `${chosen ?? ""}|${templateDefault ?? ""}`;
    let account = accounts.get(key);
    if (!account) {
      account = await resolveSenderAccount(chosen, templateDefault);
      accounts.set(key, account);
    }
    return account;
  };

  const out: (string | null)[] = [];
  for (const plan of plans) {
    const template = byTemplate.get(plan.templateId);
    if (!template) {
      out.push("Its template no longer exists");
      continue;
    }
    const account = await accountFor(plan.senderAccountId, template.senderAccountId);
    const letter: Letter = {
      subject: template.subject,
      heading: template.heading,
      body: template.body,
      kind: plan.kind,
      templateId: template.id,
      senderAccountId: template.senderAccountId,
    };
    out.push(judge(letter, client, plan.companyId, account).decision.blockedReason);
  }
  return out;
}

/** What would happen to these addressees if this template went out right now. */
export async function assessTargets(
  templateId: string,
  kind: MailoutKind,
  senderAccountId: string | null,
  targets: MailoutTarget[],
) {
  const template = await repo.findTemplate(templateId);
  if (!template) throw new NotFoundError("Template not found");
  const account = await resolveSenderAccount(senderAccountId, template.senderAccountId);
  const letter: Letter = {
    subject: template.subject,
    heading: template.heading,
    body: template.body,
    kind,
    templateId: template.id,
    senderAccountId: template.senderAccountId,
  };
  const { decisions } = await decide(letter, targets, account);
  return decisions;
}

/**
 * Fire one occurrence of a campaign.
 *
 * Records the run whatever happens — including when the firm has no postal address and a
 * commercial letter is unlawful. Refusing outright would leave the campaign due tomorrow and every
 * day after, failing silently in a place nobody looks; a run of "0 sent, 12 skipped: add the
 * firm's postal address" is the same fact, in the log, once.
 */
export async function runCampaign(campaign: {
  id: string;
  templateId: string;
  kind: MailoutKind;
  senderAccountId: string | null;
  targets: MailoutTarget[];
  periodKey: string;
}): Promise<string> {
  const firm = await repo.getFirmProfile();
  const template = await repo.findTemplate(campaign.templateId);
  if (!template) throw new NotFoundError("Template not found");
  const account = await resolveSenderAccount(
    campaign.senderAccountId,
    template.senderAccountId,
  );
  const letter: Letter = {
    subject: template.subject,
    heading: template.heading,
    body: template.body,
    kind: campaign.kind,
    templateId: template.id,
    senderAccountId: template.senderAccountId,
  };

  let blockAll: string | null = null;
  try {
    assertSendable(letter, firm);
  } catch (err) {
    blockAll = err instanceof Error ? err.message.slice(0, 300) : "This letter cannot be sent";
  }

  return dispatch(
    letter,
    account,
    firm,
    campaign.targets,
    { actorId: null, campaignId: campaign.id, periodKey: campaign.periodKey },
    blockAll,
  );
}

async function deliver(
  mailoutId: string,
  letter: Letter,
  account: SenderAccount,
  firm: FirmProfile,
) {
  const recipients = await repo.listRecipients(mailoutId);
  const queued = recipients.filter((r) => r.status === "queued");
  if (queued.length === 0) return;

  const clients = await repo.findSendableClients(queued.map((r) => r.clientId));
  const byId = new Map(clients.map((c) => [c.id, c]));

  /**
   * Resolving the account can throw before a single letter is attempted — `open()` rejects a
   * sealed SMTP password when `SECRETS_KEY` is absent or has been rotated.
   *
   * Letting that escape would leave every row `queued` forever: the caller only logs, and the
   * screen would sit on "sending" with nothing to explain it. A stuck row that never resolves is
   * a worse lie than a failure, so the reason is written against each recipient instead.
   */
  let smtp: SmtpAccount;
  let from: string;
  let logo: Awaited<ReturnType<typeof loadLogo>>;
  try {
    smtp = smtpFor(account);
    from = fromHeader(account);
    logo = await loadLogo(firm);
  } catch (err) {
    const reason =
      err instanceof Error
        ? `Sender account unusable: ${err.message}`.slice(0, 300)
        : "Sender account unusable";
    console.error(
      `[mailouts] cannot resolve the sending account for mailout=${mailoutId}:`,
      err,
    );
    for (const row of queued) {
      await repo.markRecipient(row.id, { status: "failed", reason }).catch(() => {});
    }
    return;
  }

  // Sequential on purpose: a burst of parallel connections is what gets a sending domain
  // rate-limited or greylisted, and there is no deadline here — the log is already visible.
  for (const row of queued) {
    const client = byId.get(row.clientId);
    if (!client) {
      await repo.markRecipient(row.id, {
        status: "failed",
        reason: "Client archived mid-send",
      });
      continue;
    }

    // The company is re-read from the client at delivery time rather than trusted from the row:
    // between writing the rows and sending, somebody may have deleted it. Failing loudly beats
    // sending a letter that greets a company the firm no longer has.
    const company = companyOf(client, row.companyId);
    if (row.companyId && !company) {
      await repo.markRecipient(row.id, {
        status: "failed",
        reason: "Company removed mid-send",
      });
      continue;
    }

    // `send()` mints a token for every commercial recipient before writing the rows, so this
    // cannot normally happen. It fails LOUDLY rather than falling through, because the fall-through
    // would be a commercial letter with no unsubscribe link — unlawful, and invisible.
    const token = client.mailPreference?.token ?? null;
    if (letter.kind === "commercial" && !token) {
      await repo.markRecipient(row.id, {
        status: "failed",
        reason: "No unsubscribe token — refused to send commercial mail without one",
      });
      continue;
    }

    const built = buildEmail(
      letter,
      { client, company },
      account,
      firm,
      token,
      mailoutId,
      cidSrc(logo),
    );
    const message: RawEmail = {
      to: row.email,
      subject: built.subject,
      html: built.html,
      text: built.text,
      from,
      replyTo: account.replyTo,
      account: smtp,
      attachments: logo ? [{ ...logo, cid: LOGO_CID }] : undefined,
      headers: built.headers,
    };
    try {
      await sendRawEmail(message);
      await repo.markRecipient(row.id, { status: "sent", sentAt: new Date(), reason: null });
    } catch (err) {
      // The reason is what the person reading the log will see, so it is the SENTENCE, not the
      // protocol text — `getaddrinfo ENOTFOUND` told them nothing except that something broke,
      // which the red pill beside it already said. The raw error still goes to the server log,
      // because that is what a hosting support desk asks for.
      const failure = explainSendError(err, { host: smtp.host, port: smtp.port });
      console.error(`[mailouts] send failed for recipient=${row.id} (${failure.fault}):`, err);
      // `.catch` on the marking too: if THAT throws, an unhandled rejection would abandon the
      // loop and strand every remaining recipient on `queued`. One lost status line is a much
      // smaller failure than a run that stops halfway without saying so.
      await repo
        .markRecipient(row.id, {
          status: "failed",
          reason: failure.message.slice(0, 300),
        })
        .catch((markErr) =>
          console.error(
            `[mailouts] could not record failure for recipient=${row.id}:`,
            markErr,
          ),
        );
    }
  }
}

// ── the log ──────────────────────────────────────────────────────────────────

const EMPTY_COUNTS = { sent: 0, failed: 0, skipped: 0, queued: 0 };

export async function countsFor(ids: string[]) {
  const rows = await repo.countByStatus(ids);
  const map = new Map<string, typeof EMPTY_COUNTS>();
  for (const id of ids) map.set(id, { ...EMPTY_COUNTS });
  for (const r of rows) {
    const entry = map.get(r.mailoutId);
    if (entry) entry[r.status as keyof typeof EMPTY_COUNTS] = r._count._all;
  }
  return map;
}

type MailoutRow = NonNullable<Awaited<ReturnType<typeof repo.findMailout>>>;

function toMailout(m: MailoutRow, counts: typeof EMPTY_COUNTS) {
  return {
    id: m.id,
    templateId: m.templateId,
    templateName: m.template?.name ?? null,
    subject: m.subject,
    heading: m.heading,
    body: m.body,
    kind: m.kind as MailoutKind,
    createdById: m.createdById,
    createdByName: m.createdBy ? personName(m.createdBy) : null,
    createdAt: m.createdAt.toISOString(),
    counts,
  };
}

export async function detail(id: string): Promise<MailoutDetail> {
  const m = await repo.findMailout(id);
  if (!m) throw new NotFoundError("Mailout not found");
  const counts = (await countsFor([id])).get(id)!;
  const recipients = await repo.listRecipients(id);

  return {
    ...toMailout(m, counts),
    recipients: recipients.map((r) => ({
      id: r.id,
      clientId: r.clientId,
      companyId: r.companyId,
      clientName: clientLabel(r.client),
      companyName: r.company?.name ?? null,
      email: r.email,
      status: r.status,
      reason: r.reason,
      sentAt: r.sentAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Deliberately not filterable by client: the card has its own endpoint (`clientState`), which
 * renders each subject for THAT client. A `?clientId=` here would answer the same question with
 * raw `{{vars}}` — a second, subtly wrong way to ask it.
 */
export async function list(query: MailoutListQuery): Promise<MailoutList> {
  const [rows, total] = await repo.listMailouts(
    {},
    (query.page - 1) * query.pageSize,
    query.pageSize,
  );
  const counts = await countsFor(rows.map((r) => r.id));
  return { items: rows.map((m) => toMailout(m, counts.get(m.id) ?? EMPTY_COUNTS)), total };
}

// ── the client card ──────────────────────────────────────────────────────────

/**
 * The campaigns this client is signed up for — "what are we about to send them".
 *
 * Here rather than in `campaigns.service`, though it is entirely about campaigns: this is the
 * client card's question, the card is served from this file, and putting it next door would make
 * the two service modules import each other. A cycle between two files this size resolves today
 * and breaks on the day somebody adds a top-level constant to one of them.
 */
export async function clientCampaigns(clientId: string): Promise<ClientCampaign[]> {
  const rows = await campaignRepo.listClientCampaigns(clientId);
  if (rows.length === 0) return [];

  // ONE batched assessment for the whole list — see `assessClientPlans`. This used to be a call
  // per campaign, each re-loading the same client.
  const assessed = await assessClientPlans(
    clientId,
    rows.map((r) => ({
      templateId: r.campaign.templateId,
      kind: r.campaign.kind as MailoutKind,
      senderAccountId: r.campaign.senderAccountId,
      companyId: r.companyId,
    })),
  );

  return rows.map((r, i) => ({
    id: r.campaign.id,
    name: r.campaign.name,
    kind: r.campaign.kind as MailoutKind,
    rhythm: r.campaign.rhythm as CampaignRhythm,
    status: r.campaign.status as CampaignStatus,
    nextRunOn: isoDay(r.campaign.nextRunOn),
    companyId: r.companyId,
    companyName: r.company?.name ?? null,
    blockedReason: assessed[i],
  }));
}

export async function clientState(
  clientId: string,
  query: MailoutListQuery,
): Promise<ClientMailState> {
  const [clients, pref, [rows, historyTotal], firm, campaigns] = await Promise.all([
    repo.findSendableClients([clientId]),
    repo.getMailPreference(clientId),
    repo.listClientMailouts(clientId, (query.page - 1) * query.pageSize, query.pageSize),
    repo.getFirmProfile(),
    // what is queued up for them, alongside what has already gone — see the schema comment
    clientCampaigns(clientId),
  ]);

  // Render each subject for THIS client. The mailout row stores the template text with its
  // `{{vars}}` intact — right for a record of one send to many people, wrong here, where the
  // question is "what did we send *them*". Showing the raw template on a client's own card would
  // display a letter nobody ever received.
  //
  // Rendered per row against the mailbox that actually sent it: `{{firm_name}}` in a letter from
  // "ILLION Billing" must not read back as the default mailbox's name.
  const client = clients[0];
  const clientVars: MailVars = client
    ? {
        first_name: client.firstName,
        last_name: client.lastName,
        full_name: clientLabel(client),
        company: client.companyName,
        email: client.email,
        phone: client.phone,
        address: client.address,
      }
    : {};

  return {
    subscribed: !pref?.unsubscribedAt,
    unsubscribedAt: pref?.unsubscribedAt?.toISOString() ?? null,
    unsubscribedByName: pref?.unsubscribedBy ? personName(pref.unsubscribedBy) : null,
    unsubscribedFrom: pref?.unsubscribedFrom
      ? {
          mailoutId: pref.unsubscribedFrom.id,
          subject: pref.unsubscribedFrom.subject,
          campaignId: pref.unsubscribedFrom.campaignId,
          campaignName: pref.unsubscribedFrom.campaign?.name ?? null,
        }
      : null,
    campaigns,
    hasEmail: !!client?.email,
    // Own address first, then each company in the card's own order — the same order the client's
    // Companies tab shows, so the two screens never disagree about which company is which.
    targets: client
      ? [
          { companyId: null, name: clientLabel(client), email: client.email },
          ...client.companies.map((c) => ({ companyId: c.id, name: c.name, email: c.email })),
        ]
      : [],
    history: rows.map((r) => ({
      id: r.id,
      mailoutId: r.mailoutId,
      companyId: r.companyId,
      companyName: r.company?.name ?? null,
      // A letter addressed to one of this client's companies said that company's name — so the
      // subject is re-rendered with the company it actually went to, not with the client's label.
      subject: renderMailText(r.mailout.subject, {
        ...clientVars,
        ...(r.company ? { company: r.company.name } : {}),
        firm_name: r.mailout.senderAccount?.fromName ?? firm.name,
        firm_email: r.mailout.senderAccount?.fromEmail || config.MAIL_FROM,
      }).text,
      templateName: r.mailout.template?.name ?? null,
      kind: r.mailout.kind as MailoutKind,
      status: r.status,
      reason: r.reason,
      sentAt: r.sentAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    historyTotal,
  };
}

/**
 * One letter, as ONE addressee received it.
 *
 * The client card used to open the mailout-level detail, which lists every recipient — so opening
 * a letter from Olena's card showed Petro's name, address and skip reason. Correct in the Mailouts
 * log, a leak on a client's own card.
 *
 * Scoped by construction: the query matches on `(recipient row, client)`, so there is no list to
 * forget to filter. Keyed on the ROW rather than the mailout because one mailout may now reach
 * this client several times over — their own inbox and one per company — and those are different
 * letters with different `{{company}}` in them.
 *
 * The body is rendered with this addressee's values too: the stored snapshot keeps its `{{vars}}`,
 * which is right for a record of one send to many and wrong for "what did they actually get".
 */
export async function clientLetter(
  recipientId: string,
  clientId: string,
): Promise<ClientMailoutDetail> {
  const row = await repo.findClientLetter(recipientId, clientId);
  if (!row) throw new NotFoundError("This client did not receive that letter");

  const firm = await repo.getFirmProfile();
  const account = row.mailout.senderAccount;
  const vars: MailVars = {
    first_name: row.client.firstName,
    last_name: row.client.lastName,
    full_name: clientLabel(row.client),
    company: row.company ? row.company.name : row.client.companyName,
    email: row.email,
    phone: row.company?.phone || row.client.phone,
    address: row.client.address,
    firm_name: account?.fromName ?? firm.name,
    firm_email: account?.fromEmail || config.MAIL_FROM,
  };

  return {
    id: row.id,
    mailoutId: row.mailoutId,
    companyId: row.companyId,
    companyName: row.company?.name ?? null,
    subject: renderMailText(row.mailout.subject, vars).text,
    heading: row.mailout.heading ? renderMailText(row.mailout.heading, vars).text : null,
    body: renderMailText(row.mailout.body, vars).text,
    templateName: row.mailout.template?.name ?? null,
    kind: row.mailout.kind as MailoutKind,
    sentByName: row.mailout.createdBy ? personName(row.mailout.createdBy) : null,
    senderName: account?.name ?? null,
    createdAt: row.mailout.createdAt.toISOString(),
    status: row.status,
    reason: row.reason,
    email: row.email,
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}

/**
 * Defaults straight off the query schema, so "the first page" is defined in exactly one place.
 * Writing `{ page: 1, pageSize: 25 }` here would be a second copy of a number that already exists,
 * and the two would drift the first time the page size changed.
 */
const FIRST_PAGE = mailoutListQuery.parse({});

export async function setSubscription(actor: User, clientId: string, subscribed: boolean) {
  await repo.setUnsubscribed(clientId, subscribed ? null : new Date(), actor.id);
  return clientState(clientId, FIRST_PAGE);
}

// ── the public unsubscribe page ──────────────────────────────────────────────

/**
 * Applied by the client's own click. No actor — nobody in the firm did this.
 *
 * `fromMailoutId` comes out of the link and is therefore a CLAIM. It is stored only after checking
 * that the named mailout really did write to this client; otherwise it is dropped and the opt-out
 * still happens. Getting the opt-out right matters, knowing which letter prompted it is a nicety,
 * and the nicety must never be able to break the thing that matters.
 */
export async function unsubscribeByToken(
  token: string,
  fromMailoutId: string | null = null,
): Promise<void> {
  const pref = await repo.findByUnsubscribeToken(token);
  if (!pref) throw new NotFoundError("This unsubscribe link is not valid");
  if (pref.unsubscribedAt) return; // already done — say so calmly, do not error

  let source: string | null = null;
  if (fromMailoutId) {
    try {
      source = (await campaignRepo.mailoutIncludesClient(fromMailoutId, pref.clientId))
        ? fromMailoutId
        : null;
    } catch {
      source = null; // a malformed id must not cost the client their opt-out
    }
  }
  await repo.setUnsubscribed(pref.clientId, new Date(), null, source);
}

export async function unsubscribeTokenExists(token: string): Promise<boolean> {
  return !!(await repo.findByUnsubscribeToken(token));
}

/** The name the unsubscribe page says the client is leaving — the same one that signed the letter. */
export async function senderDisplayName(): Promise<string> {
  const account = await repo.findDefaultSenderAccount();
  return account?.fromName || (await repo.getFirmProfile()).name;
}

/**
 * The confirmation and result pages, rendered server-side.
 *
 * Deliberately not a SPA route: the person clicking has no account, the app is otherwise entirely
 * behind auth, and a static page with a form works in every mail client's in-app browser without
 * JavaScript.
 */
export function unsubscribePage(opts: {
  token: string;
  firmName: string;
  state: "confirm" | "done" | "invalid";
  /** carried through from the GET, so the POST that follows knows the letter too */
  fromMailoutId?: string | null;
}): string {
  const brand = "#37544F";
  const title =
    opts.state === "done"
      ? "You have been unsubscribed"
      : opts.state === "invalid"
        ? "This link is no longer valid"
        : "Unsubscribe from updates";

  const body =
    opts.state === "done"
      ? `<p>You will no longer receive news and updates from ${escapeHtml(opts.firmName)}.</p>
         <p style="color:#6b7a77;font-size:14px;">Invoices and messages about your account are not
         affected — you will keep receiving those.</p>`
      : opts.state === "invalid"
        ? `<p>We could not find this subscription. It may have already been removed.</p>`
        : `<p>Stop receiving news and updates from ${escapeHtml(opts.firmName)}?</p>
           <p style="color:#6b7a77;font-size:14px;">Invoices and messages about your account will
           still reach you.</p>
           <form method="post" action="/api/mailouts/unsubscribe/${escapeHtml(opts.token)}${
             opts.fromMailoutId ? `?m=${escapeHtml(opts.fromMailoutId)}` : ""
           }">
             <button type="submit" style="margin-top:8px;background:${brand};color:#fff;border:0;
               border-radius:8px;padding:11px 20px;font-size:15px;cursor:pointer;">
               Unsubscribe
             </button>
           </form>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f4f6f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:520px;margin:56px auto;background:#fff;border:1px solid #dfe5e3;border-radius:10px;padding:32px;">
  <div style="height:3px;width:44px;background:${brand};border-radius:2px;"></div>
  <h1 style="font-size:20px;color:${brand};margin:16px 0 14px;">${escapeHtml(title)}</h1>
  <div style="font-size:15px;line-height:1.6;color:#1f2a28;">${body}</div>
</div>
</body></html>`;
}
