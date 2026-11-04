import type { InvoiceLineUnit } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";

const fields = { id: true, name: true, unit: true, price: true, active: true } as const;

/** Every item, by name: Settings lists them all, and the picker leaves the inactive ones out. */
export function listInvoiceItems() {
  return prisma.invoiceItem.findMany({ select: fields, orderBy: { name: "asc" } });
}

export function findInvoiceItem(id: string) {
  return prisma.invoiceItem.findUnique({ where: { id }, select: fields });
}

/**
 * The test `InvoiceItem_name_key_ci` makes, inactive items included. Not Prisma's insensitive
 * `equals`: that is an ILIKE, where "50%" matched "50 hours" and a name ending in `\` failed.
 */
export async function findInvoiceItemByName(name: string) {
  const [row] = await prisma.$queryRaw<{ id: string; active: boolean }[]>`
    SELECT id, active FROM "InvoiceItem" WHERE lower(name) = lower(${name}) LIMIT 1
  `;
  return row ?? null;
}

/** Lines that came from it, cancelled invoices included: all of them keep pointing at it. */
export function countInvoiceItemLines(id: string) {
  return prisma.invoiceLine.count({ where: { itemId: id } });
}

export function createInvoiceItem(data: {
  name: string;
  unit: InvoiceLineUnit;
  price: number | null;
}) {
  return prisma.invoiceItem.create({ data, select: fields });
}

export function updateInvoiceItem(
  id: string,
  data: { name?: string; unit?: InvoiceLineUnit; price?: number | null; active?: boolean },
) {
  return prisma.invoiceItem.update({ where: { id }, data, select: fields });
}

/** A line written meanwhile makes the database refuse it (`InvoiceLine.itemId` is RESTRICT). */
export function deleteInvoiceItem(id: string) {
  return prisma.invoiceItem.delete({ where: { id } });
}
