import { randomBytes } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";

// ── templates ────────────────────────────────────────────────────────────────

export function listTemplates() {
  return prisma.emailTemplate.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] });
}

export function findTemplate(id: string) {
  return prisma.emailTemplate.findUnique({ where: { id } });
}

/** Several templates in one query — the client card asks about every campaign it is on at once. */
export function findTemplatesByIds(ids: string[]) {
  return prisma.emailTemplate.findMany({ where: { id: { in: ids } } });
}

export function findTemplateByName(name: string) {
  return prisma.emailTemplate.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
}

export function createTemplate(data: Prisma.EmailTemplateCreateInput) {
  return prisma.emailTemplate.create({ data });
}

export function updateTemplate(id: string, data: Prisma.EmailTemplateUpdateInput) {
  return prisma.emailTemplate.update({ where: { id }, data });
}

/** Templates are never deleted while a send references them — history must stay readable. */
export function countMailoutsForTemplate(templateId: string) {
  return prisma.mailout.count({ where: { templateId } });
}

/**
 * …nor while a campaign is scheduled to send it.
 *
 * `Campaign.templateId` is ON DELETE RESTRICT, so the database refuses this either way — the count
 * is what turns that refusal into a sentence naming the campaign instead of a 500.
 */
export function countCampaignsForTemplate(templateId: string) {
  return prisma.campaign.count({ where: { templateId } });
}

export function deleteTemplate(id: string) {
  return prisma.emailTemplate.delete({ where: { id } });
}

// ── recipients ───────────────────────────────────────────────────────────────

/**
 * The clients a send may target, with everything the renderer needs in one query.
 *
 * Archived clients are excluded here rather than filtered later: an archived client is out of the
 * firm's active book, and mailing them is exactly the mistake archiving exists to prevent.
 *
 * Companies come along because a send may be addressed to one of them. Loaded WITH their client
 * rather than looked up on their own, so "is this company really this client's" is answered by
 * the shape of the data instead of by a check somebody has to remember to write.
 */
export function findSendableClients(ids: string[]) {
  return prisma.client.findMany({
    where: { id: { in: ids }, archivedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      companyName: true,
      email: true,
      phone: true,
      address: true,
      companies: {
        select: { id: true, name: true, email: true, phone: true },
        orderBy: [{ order: "asc" }, { name: "asc" }],
      },
      mailPreference: { select: { unsubscribedAt: true, token: true } },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
}

// ── the unsubscribe token ────────────────────────────────────────────────────

/**
 * Give every one of these clients a stable unsubscribe token, and return them all.
 *
 * Two queries regardless of how many clients — NOT one upsert per client in a loop. A send may name
 * 500 recipients and this runs inside the request that the person is waiting on; 500 sequential
 * round trips is the kind of cost that is invisible against three dev clients and times out
 * against a real book of business.
 *
 * `skipDuplicates` rather than upsert-each: two sends racing on the same client must not collide
 * on the primary key, and neither one needs to win — an existing token is exactly as good.
 */
export async function ensureMailPreferences(clientIds: string[]) {
  if (clientIds.length === 0) return new Map<string, string>();

  await prisma.clientMailPreference.createMany({
    data: clientIds.map((clientId) => ({
      clientId,
      token: randomBytes(24).toString("base64url"),
    })),
    skipDuplicates: true,
  });

  const rows = await prisma.clientMailPreference.findMany({
    where: { clientId: { in: clientIds } },
    select: { clientId: true, token: true },
  });
  return new Map(rows.map((r) => [r.clientId, r.token]));
}

export function findByUnsubscribeToken(token: string) {
  return prisma.clientMailPreference.findUnique({
    where: { token },
    select: { clientId: true, unsubscribedAt: true, client: { select: { archivedAt: true } } },
  });
}

/**
 * `fromMailoutId` is the letter whose link was clicked, already verified by the service.
 *
 * Cleared on re-subscribe along with the rest: a stale "unsubscribed from the March newsletter"
 * hanging off a client who is subscribed again would be read as current by anyone who saw it.
 */
export function setUnsubscribed(
  clientId: string,
  at: Date | null,
  byUserId: string | null,
  fromMailoutId: string | null = null,
) {
  return prisma.clientMailPreference.upsert({
    where: { clientId },
    create: {
      clientId,
      token: randomBytes(24).toString("base64url"),
      unsubscribedAt: at,
      unsubscribedById: byUserId,
      unsubscribedFromMailoutId: at ? fromMailoutId : null,
    },
    update: {
      unsubscribedAt: at,
      unsubscribedById: at ? byUserId : null,
      unsubscribedFromMailoutId: at ? fromMailoutId : null,
    },
  });
}

export function getMailPreference(clientId: string) {
  return prisma.clientMailPreference.findUnique({
    where: { clientId },
    select: {
      unsubscribedAt: true,
      unsubscribedBy: { select: { firstName: true, lastName: true } },
      // which letter's link they clicked, and what it was part of — so the card can say
      // "unsubscribed after the March newsletter" rather than only "unsubscribed"
      unsubscribedFrom: {
        select: {
          id: true,
          subject: true,
          campaignId: true,
          campaign: { select: { name: true } },
        },
      },
    },
  });
}

// ── the log ──────────────────────────────────────────────────────────────────

const mailoutInclude = {
  template: { select: { name: true } },
  createdBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.MailoutInclude;

export function createMailout(
  data: Prisma.MailoutCreateInput,
  recipients: Prisma.MailoutRecipientCreateManyMailoutInput[],
) {
  return prisma.mailout.create({
    data: { ...data, recipients: { createMany: { data: recipients } } },
    include: mailoutInclude,
  });
}

export function markRecipient(
  id: string,
  data: {
    status: "sent" | "failed";
    reason?: string | null;
    sentAt?: Date | null;
    /** the `Message-ID` the letter carried, so a bounce quoting it can find this row */
    messageId?: string | null;
  },
) {
  return prisma.mailoutRecipient.update({ where: { id }, data });
}

export function listRecipients(mailoutId: string) {
  return prisma.mailoutRecipient.findMany({
    where: { mailoutId },
    include: {
      client: { select: { firstName: true, lastName: true } },
      company: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

export function countByStatus(mailoutIds: string[]) {
  return prisma.mailoutRecipient.groupBy({
    by: ["mailoutId", "status"],
    where: { mailoutId: { in: mailoutIds } },
    _count: { _all: true },
  });
}

export function findMailout(id: string) {
  return prisma.mailout.findUnique({ where: { id }, include: mailoutInclude });
}

export function listMailouts(where: Prisma.MailoutWhereInput, skip: number, take: number) {
  return prisma.$transaction([
    prisma.mailout.findMany({
      where,
      include: mailoutInclude,
      /** Same reason as the client card's: `OFFSET` over a tie is not a stable window. */
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take,
    }),
    prisma.mailout.count({ where }),
  ]);
}

/** One client's letters, for the card's Mailouts tab — their own inbox and their companies'. */
export function listClientMailouts(clientId: string, skip: number, take: number) {
  return prisma.$transaction([
    prisma.mailoutRecipient.findMany({
      where: { clientId },
      include: {
        company: { select: { name: true } },
        mailout: {
          include: {
            template: { select: { name: true } },
            // each letter may have gone from a different mailbox, and the subject is re-rendered
            // per row — so the row needs the mailbox that actually sent it, not an approximation
            senderAccount: { select: { fromName: true, fromEmail: true } },
          },
        },
      },
      /**
       * `id` is not decoration: `createdAt` alone is not a total order.
       *
       * One mailout to a client with three companies writes three rows in the same instant, and a
       * tie leaves Postgres free to return them in any order per query — so `OFFSET` slid over an
       * unstable list, repeating a letter on page 2 and dropping another one entirely. Unnoticeable
       * while the card returned every row at once; a paging bug the moment it did not.
       */
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take,
    }),
    prisma.mailoutRecipient.count({ where: { clientId } }),
  ]);
}

/**
 * One letter as one client received it — the only shape a client's card is ever given.
 *
 * Keyed on the RECIPIENT row, not on the mailout: one mailout can now reach the same client
 * several times over (their own address, then one company's, then another's), so the mailout no
 * longer identifies a letter. `clientId` stays in the `where` as the scope — a recipient id
 * belonging to somebody else simply does not match, so this cannot answer with another client's
 * row however it is called.
 */
export function findClientLetter(recipientId: string, clientId: string) {
  return prisma.mailoutRecipient.findFirst({
    where: { id: recipientId, clientId },
    include: {
      company: { select: { id: true, name: true, email: true, phone: true } },
      client: {
        select: {
          firstName: true,
          lastName: true,
          companyName: true,
          email: true,
          phone: true,
          address: true,
        },
      },
      mailout: {
        include: {
          template: { select: { name: true } },
          createdBy: { select: { firstName: true, lastName: true } },
          senderAccount: { select: { name: true, fromName: true, fromEmail: true } },
        },
      },
    },
  });
}

// ── the firm's own row ───────────────────────────────────────────────────────
//
// `FirmProfile` is a singleton two modules read, and that is deliberate rather than an oversight:
// Settings owns the firm's identity and invoice numbering, Mailouts owns `postalAddress`. Same
// row, separate concerns, neither writes the other's columns.

export function getFirmProfile() {
  return prisma.firmProfile.findUniqueOrThrow({
    where: { id: 1 },
    include: {
      // the LETTERHEAD logo, not the sidebar one — see the schema comment on mailLogoFileId
      mailLogoFile: { select: { id: true, path: true, mime: true, name: true } },
    },
  });
}

export function updateFirmProfile(data: Prisma.FirmProfileUpdateInput) {
  return prisma.firmProfile.update({ where: { id: 1 }, data });
}

export function createFileRow(data: Prisma.FileUncheckedCreateInput) {
  return prisma.file.create({ data });
}

export function deleteFileRow(id: string) {
  return prisma.file.delete({ where: { id } });
}

// ── sender mailboxes ─────────────────────────────────────────────────────────

export function listSenderAccounts() {
  return prisma.mailSenderAccount.findMany({
    orderBy: [{ isDefault: "desc" }, { active: "desc" }, { name: "asc" }],
  });
}

export function findSenderAccount(id: string) {
  return prisma.mailSenderAccount.findUnique({ where: { id } });
}

export function findSenderAccountByName(name: string) {
  return prisma.mailSenderAccount.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
}

/** The one a send falls back to when neither the template nor the composer named one. */
export function findDefaultSenderAccount() {
  return prisma.mailSenderAccount.findFirst({ where: { isDefault: true } });
}

export function createSenderAccount(data: Prisma.MailSenderAccountCreateInput) {
  return prisma.mailSenderAccount.create({ data });
}

export function updateSenderAccount(id: string, data: Prisma.MailSenderAccountUpdateInput) {
  return prisma.mailSenderAccount.update({ where: { id }, data });
}

/**
 * Move the default, atomically.
 *
 * A partial unique index enforces "at most one default", so clearing and setting in two separate
 * statements would collide with itself the moment two admins did this at once. One transaction,
 * clear-then-set, is the same shape `Priority.isDefault` uses.
 */
export function makeSenderAccountDefault(id: string) {
  return prisma.$transaction([
    prisma.mailSenderAccount.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    }),
    prisma.mailSenderAccount.update({ where: { id }, data: { isDefault: true } }),
  ]);
}

/**
 * Name the mailbox invoices go from — the same clear-then-set shape as the default, for the same
 * reason: a partial unique index means two statements would collide with themselves.
 */
export function makeInvoiceSender(id: string) {
  return prisma.$transaction([
    prisma.mailSenderAccount.updateMany({
      where: { isInvoiceSender: true },
      data: { isInvoiceSender: false },
    }),
    prisma.mailSenderAccount.update({ where: { id }, data: { isInvoiceSender: true } }),
  ]);
}

/** History points at accounts; the service refuses to delete one that anything still references. */
export function countSenderAccountUsage(id: string) {
  return prisma.$transaction([
    prisma.mailout.count({ where: { senderAccountId: id } }),
    prisma.emailTemplate.count({ where: { senderAccountId: id } }),
  ]);
}

export function deleteSenderAccount(id: string) {
  return prisma.mailSenderAccount.delete({ where: { id } });
}

export function countSenderAccounts() {
  return prisma.mailSenderAccount.count();
}
