import { prisma } from "../../core/db.js";

/** What the pay link needs of an invoice: what it owes, who it is addressed to, and its version. */
export function findInvoiceByPayToken(payToken: string) {
  return prisma.invoice.findUnique({
    where: { payToken },
    select: {
      id: true,
      number: true,
      clientId: true,
      amount: true,
      paidTotal: true,
      cancelledAt: true,
      updatedAt: true,
      client: { select: { firstName: true, lastName: true, email: true } },
      company: { select: { email: true } },
    },
  });
}

export type PayLinkInvoice = NonNullable<Awaited<ReturnType<typeof findInvoiceByPayToken>>>;

/**
 * The open session a click may reuse: for exactly this balance, made with the same mode's key, and
 * with time left to pay in. The newest, should a race ever have left two.
 */
export function findReusableCheckout(where: {
  invoiceId: string;
  amount: number;
  livemode: boolean;
  openUntilAfter: Date;
}) {
  return prisma.stripeCheckout.findFirst({
    where: {
      invoiceId: where.invoiceId,
      amount: where.amount,
      livemode: where.livemode,
      status: "open",
      expiresAt: { gt: where.openUntilAfter },
    },
    orderBy: { createdAt: "desc" },
    select: { url: true },
  });
}

/**
 * A session Stripe made. By its id, because two clicks at the same moment send one idempotency key
 * and get the SAME session back: the second insert would otherwise trip the unique index.
 */
export function saveCheckout(data: {
  sessionId: string;
  invoiceId: string;
  amount: number;
  url: string;
  expiresAt: Date;
  livemode: boolean;
}) {
  return prisma.stripeCheckout.upsert({
    where: { sessionId: data.sessionId },
    create: data,
    update: {},
    select: { createdAt: true },
  });
}

/** Sessions still open on these invoices, by their own clock, made with this mode's key. */
export function findOpenCheckouts(where: {
  invoiceIds: string[];
  livemode: boolean;
  now: Date;
  /** leave out this session and anything newer: a click never closes the session it just made */
  createdBefore?: Date;
  /** leave out the sessions for this balance: what is still owed keeps its page */
  amountOtherThan?: number;
}) {
  return prisma.stripeCheckout.findMany({
    where: {
      invoiceId: { in: where.invoiceIds },
      livemode: where.livemode,
      status: "open",
      expiresAt: { gt: where.now },
      ...(where.createdBefore ? { createdAt: { lt: where.createdBefore } } : {}),
      ...(where.amountOtherThan !== undefined
        ? { amount: { not: where.amountOtherThan } }
        : {}),
    },
    select: { id: true, sessionId: true, invoiceId: true },
  });
}

export type OpenCheckout = Awaited<ReturnType<typeof findOpenCheckouts>>[number];

export function markCheckoutExpired(id: string) {
  return prisma.stripeCheckout.update({ where: { id }, data: { status: "expired" } });
}
