import { z } from "zod";
import { fmtMoney } from "../money.js";
import { money, uuid } from "./common.js";
import { invoiceLineUnit } from "./enums.js";

/**
 * **Invoice items** (payments.md §3, the client's request of 2026-11-02): positions the firm bills
 * often, kept on Settings → Invoices. New invoice and the admin's correction pick one, which fills
 * the line; the line keeps its own copy, so nothing here changes an invoice already issued.
 *
 * Read by everybody who writes invoices (`shared()`): names, units and prices, which the catalog's
 * own `shared()` read already shows. Nothing about where or how often an item was billed.
 */
export const invoiceItemSchema = z.object({
  id: uuid,
  name: z.string(),
  unit: invoiceLineUnit,
  /** minor units per hour or per item; null = typed on each invoice */
  price: money.nullable(),
  /** false = kept for the lines that came from it, and left out of the picker */
  active: z.boolean(),
});
export type InvoiceItem = z.infer<typeof invoiceItemSchema>;

/** $1,000,000.00: far above any price, and far below what the integer column holds */
export const INVOICE_ITEM_PRICE_MAX = 1_000_000_00;

export const createInvoiceItemInput = z.object({
  /** it becomes the line's description, so it is as long as one may be */
  name: z.string().trim().min(1).max(200),
  unit: invoiceLineUnit,
  price: money.min(1).max(INVOICE_ITEM_PRICE_MAX).nullable(),
});
export type CreateInvoiceItemInput = z.infer<typeof createInvoiceItemInput>;

/** What changed: omitted leaves it alone, so a stale form cannot undo a colleague's edit. */
export const updateInvoiceItemInput = createInvoiceItemInput
  .extend({ active: z.boolean() })
  .partial();
export type UpdateInvoiceItemInput = z.infer<typeof updateInvoiceItemInput>;

/** "$50.00 per item", or "per hour" for an item whose price is typed on each invoice. */
export const itemPriceLabel = (item: Pick<InvoiceItem, "unit" | "price">) =>
  `${item.price !== null ? `${fmtMoney(item.price)} ` : ""}per ${item.unit}`;
