import type {
  CreatePaymentDetailsInput,
  PaymentDetails,
  PaymentDetailsOption,
  UpdatePaymentDetailsInput,
} from "@shared/schema/payment-details.js";
import { record } from "../../core/activity.js";
import { ConflictError, NotFoundError } from "../../core/errors.js";
import * as repo from "./payment-details.repository.js";
import { linesOnlyIn } from "./settings.service.js";

/**
 * **Sets of payment details** (payments.md §10, 2026-11-02). Settings → Invoices edits them, an
 * admin's writes whoever holds Settings; Payments copies one onto each invoice at issue
 * (`insertInvoice`), so nothing here changes an invoice already issued.
 *
 * Every write answers with the whole list: the screen shows it, and a default moving or a set
 * archived changes more than one row of it.
 */

function toDto(set: repo.PaymentDetailsRecord): PaymentDetails {
  return {
    id: set.id,
    name: set.name,
    details: set.details,
    isDefault: set.isDefault,
    archivedAt: set.archivedAt?.toISOString() ?? null,
    clients: set._count.clients,
  };
}

export async function listPaymentDetails() {
  return (await repo.listPaymentDetails()).map(toDto);
}

export function listPaymentDetailsOptions(): Promise<PaymentDetailsOption[]> {
  return repo.listPaymentDetailsOptions();
}

async function findOrThrow(id: string) {
  const set = await repo.findPaymentDetails(id);
  if (!set) throw new NotFoundError("Payment details not found");
  return set;
}

async function refuseNameClash(name: string, exceptId?: string) {
  const clash = await repo.findLivePaymentDetailsByName(name);
  if (clash && clash.id !== exceptId) {
    throw new ConflictError(`Payment details named “${name}” already exist`);
  }
}

/** The first live set becomes the default (`repo.createPaymentDetails`). */
export async function createPaymentDetails(input: CreatePaymentDetailsInput) {
  await refuseNameClash(input.name);
  const created = await repo.createPaymentDetails(input);
  // the text itself, as a mailbox logs its address: the log keeps its first 200 characters
  record("payment_details.created", {
    subjectId: created.id,
    subjectLabel: created.name,
    changes: { details: created.details },
  });
  if (created.isDefault) {
    record("payment_details.default_changed", {
      subjectId: created.id,
      subjectLabel: created.name,
    });
  }
  return listPaymentDetails();
}

/** An archived set is kept as the invoices issued with it knew it, so it is not edited. */
export async function updatePaymentDetails(id: string, input: UpdatePaymentDetailsInput) {
  const before = await findOrThrow(id);
  if (before.archivedAt) throw new ConflictError("An archived set is kept as it was");
  const name = input.name !== undefined && input.name !== before.name ? input.name : undefined;
  const details =
    input.details !== undefined && input.details !== before.details ? input.details : undefined;
  // decided on the text itself: the log's line diff below reads two orders of the same lines as one
  if (name === undefined && details === undefined) return listPaymentDetails();
  if (name !== undefined) await refuseNameClash(name, id);
  const updated = await repo.updatePaymentDetails(id, { name, details });
  record("payment_details.updated", {
    subjectId: id,
    subjectLabel: updated.name,
    changes: {
      ...(name !== undefined ? { name: { from: before.name, to: name } } : {}),
      ...(details !== undefined ? { details: changedLines(before.details, details) } : {}),
    },
  });
  return listPaymentDetails();
}

/**
 * What the log keeps of a new text: the lines that changed, or, when only their order did, both
 * texts (200 characters of each), so the row still says something moved.
 */
function changedLines(before: string, after: string) {
  const from = linesOnlyIn(before, after);
  const to = linesOnlyIn(after, before);
  return from === null && to === null ? { from: before, to: after } : { from, to };
}

export async function makePaymentDetailsDefault(id: string) {
  const set = await findOrThrow(id);
  if (set.archivedAt) throw new ConflictError("An archived set cannot be the default");
  if (set.isDefault) return listPaymentDetails();
  await repo.makePaymentDetailsDefault(id);
  record("payment_details.default_changed", { subjectId: id, subjectLabel: set.name });
  return listPaymentDetails();
}

/**
 * Archived, never deleted: invoices issued with it point at it. Refused for the default, and while
 * a live client names it. An archived client may still name it: restored, they print the default.
 */
export async function archivePaymentDetails(id: string) {
  const set = await findOrThrow(id);
  if (set.archivedAt) return listPaymentDetails();
  if (set.isDefault) {
    throw new ConflictError("Make another set the default before archiving this one");
  }
  const count = set._count.clients;
  if (count > 0) {
    throw new ConflictError(
      `“${set.name}” is used by ${count} client${count === 1 ? "" : "s"}. Move them to another set first`,
    );
  }
  // the same rules again under the set's row lock: a client may have been moved onto it since
  if (!(await repo.archivePaymentDetails(id))) {
    throw new ConflictError(`“${set.name}” is in use now. Reload and try again`);
  }
  record("payment_details.archived", { subjectId: id, subjectLabel: set.name });
  return listPaymentDetails();
}
