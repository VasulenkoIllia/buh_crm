import type {
  CreateInvoiceItemInput,
  InvoiceItem,
  UpdateInvoiceItemInput,
} from "@shared/schema/invoice-items.js";
import { diff, record } from "../../core/activity.js";
import { ConflictError, NotFoundError } from "../../core/errors.js";
import * as repo from "./invoice-items.repository.js";

/**
 * **Invoice items** (payments.md §3, 2026-11-02): Settings → Invoices edits them, whoever has
 * Settings open; New invoice and the correction pick from them. A line keeps its own copy, so a
 * rename or a new price here reaches the next invoices, never the ones already issued.
 *
 * Every write answers with the whole list, as the payment details sets do: the screen shows it,
 * and a rename can move a row.
 */

export function listInvoiceItems(): Promise<InvoiceItem[]> {
  return repo.listInvoiceItems();
}

async function findOrThrow(id: string) {
  const item = await repo.findInvoiceItem(id);
  if (!item) throw new NotFoundError("Invoice item not found");
  return item;
}

/** The friendly half of `InvoiceItem_name_key_ci`, which still refuses a race (409 either way). */
async function refuseNameClash(name: string, exceptId?: string) {
  const clash = await repo.findInvoiceItemByName(name);
  if (clash && clash.id !== exceptId) {
    throw new ConflictError(`An item named “${name}” already exists`);
  }
}

export async function createInvoiceItem(input: CreateInvoiceItemInput) {
  await refuseNameClash(input.name);
  const created = await repo.createInvoiceItem(input);
  record("invoice_item.created", {
    subjectId: created.id,
    subjectLabel: created.name,
    changes: { unit: created.unit, price: created.price },
  });
  return listInvoiceItems();
}

const LOGGED = ["name", "unit", "price", "active"] as const;

/**
 * Writes only what differs from the row as read, the same fields the log names, so a value sent
 * unchanged never overwrites a colleague's edit that landed in between.
 */
export async function updateInvoiceItem(id: string, input: UpdateInvoiceItemInput) {
  const before = await findOrThrow(id);
  const changes = diff(before, input, LOGGED);
  if (!changes) return listInvoiceItems();
  if (changes.name && input.name !== undefined) await refuseNameClash(input.name, id);
  const data = Object.fromEntries(
    LOGGED.filter((key) => key in changes).map((key) => [key, input[key]]),
  ) as UpdateInvoiceItemInput;
  const updated = await repo.updateInvoiceItem(id, data);
  record("invoice_item.updated", { subjectId: id, subjectLabel: updated.name, changes });
  return listInvoiceItems();
}

/**
 * Only while no line came from it, on any invoice, cancelled ones included: the line points at it.
 * Switching it off is the way out, and the refusal says so.
 */
export async function deleteInvoiceItem(id: string) {
  const item = await findOrThrow(id);
  const lines = await repo.countInvoiceItemLines(id);
  if (lines > 0) {
    throw new ConflictError(
      `“${item.name}” is on ${lines} invoice position${lines === 1 ? "" : "s"}. Switch it off instead of deleting`,
    );
  }
  try {
    await repo.deleteInvoiceItem(id);
  } catch (err) {
    // a line written between the count and the delete: the foreign key refused it
    if ((err as { code?: string }).code !== "P2003") throw err;
    throw new ConflictError(
      `“${item.name}” went on an invoice just now. Switch it off instead`,
    );
  }
  record("invoice_item.deleted", { subjectId: id, subjectLabel: item.name });
  return listInvoiceItems();
}
