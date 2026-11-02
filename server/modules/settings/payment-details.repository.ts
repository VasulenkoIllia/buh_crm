import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import { ConflictError } from "../../core/errors.js";

/**
 * Live clients only. An archived client cannot be moved from the card, so counting them would keep
 * a set from being archived for ever; restored, such a client prints the default (`findPaymentDetailsFor`).
 */
const LIVE_CLIENTS = { archivedAt: null } satisfies Prisma.ClientWhereInput;

const withClientCount = {
  _count: { select: { clients: { where: LIVE_CLIENTS } } },
} satisfies Prisma.PaymentDetailsInclude;

export type PaymentDetailsRecord = Prisma.PaymentDetailsGetPayload<{
  include: typeof withClientCount;
}>;

/** Live sets first, the default at the top; archived ones after, newest archive first. */
export function listPaymentDetails() {
  return prisma.paymentDetails.findMany({
    include: withClientCount,
    orderBy: [
      { archivedAt: { sort: "desc", nulls: "first" } },
      { isDefault: "desc" },
      { name: "asc" },
    ],
  });
}

/** For screens that are not Settings: names only, live sets only. */
export function listPaymentDetailsOptions() {
  return prisma.paymentDetails.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true, isDefault: true },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });
}

export function findPaymentDetails(id: string) {
  return prisma.paymentDetails.findUnique({ where: { id }, include: withClientCount });
}

/** Case-insensitive, among live sets: two "International" in one select would be a coin toss. */
export function findLivePaymentDetailsByName(name: string) {
  return prisma.paymentDetails.findFirst({
    where: { archivedAt: null, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
}

/**
 * The first live set is made the default as it is created, in one transaction: sets with no default
 * would leave every client who names none with nothing to print. Two first sets at once meet the
 * one-default index, and the second is refused whole, never left half made.
 */
export function createPaymentDetails(data: { name: string; details: string }) {
  return prisma.$transaction(async (tx) => {
    const defaults = await tx.paymentDetails.count({
      where: { isDefault: true, archivedAt: null },
    });
    return tx.paymentDetails.create({ data: { ...data, isDefault: defaults === 0 } });
  });
}

/** The name and the text only: the default and the archive move through their own paths. */
export function updatePaymentDetails(id: string, data: { name?: string; details?: string }) {
  return prisma.paymentDetails.update({ where: { id }, data });
}

/**
 * Move the default, atomically: clear, then set, in one transaction. A partial unique index allows
 * one live default, so the two statements apart would collide with each other (the shape
 * `makeSenderAccountDefault` uses). The set is asked to be live in the same statement that marks
 * it: archived a moment earlier, it would leave the firm with no default at all, so the clearing is
 * rolled back with it.
 */
export function makePaymentDetailsDefault(id: string) {
  return prisma.$transaction(async (tx) => {
    await tx.paymentDetails.updateMany({
      where: { isDefault: true, archivedAt: null, id: { not: id } },
      data: { isDefault: false },
    });
    const { count } = await tx.paymentDetails.updateMany({
      where: { id, archivedAt: null },
      data: { isDefault: true },
    });
    if (count !== 1) throw new ConflictError("Those payment details were archived meanwhile");
  });
}

/**
 * Archive, but only while it is not the default and no live client names it.
 *
 * The set's row lock comes first, the count after it: a client being moved onto the set holds that
 * row (`lockLivePaymentDetails`), so the count waits for the move and then sees it. A count read
 * without the lock could miss a client moved onto the set in between. False = refused; the service
 * says why.
 */
export function archivePaymentDetails(id: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PaymentDetails" WHERE id = ${id}::uuid FOR UPDATE`;
    const inUse = await tx.client.count({ where: { paymentDetailsId: id, ...LIVE_CLIENTS } });
    if (inUse > 0) return false;
    const { count } = await tx.paymentDetails.updateMany({
      where: { id, archivedAt: null, isDefault: false },
      data: { archivedAt: new Date() },
    });
    return count === 1;
  });
}
