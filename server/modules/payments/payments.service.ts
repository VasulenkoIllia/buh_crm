import type {
  AddPaymentInput,
  BulkArchiveInput,
  BulkDeliveryInput,
  CreateInvoiceInput,
  InvoiceListQuery,
  MarkPaidInput,
  SetDeliveryInput,
  UpdateInvoiceInput,
  UpdatePaymentInput,
} from "@shared/schema/payment.js";
import { deriveStatus } from "@shared/schema/payment.js";
import type { Prisma, User } from "../../generated/prisma/client.js";
import { config } from "../../core/config.js";
import { dateToUtc, todayBusinessMs } from "../../core/dates.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import { clientLabel, personName } from "../../core/names.js";
import { issueInvoice } from "./invoicing.js";
import * as repo from "./payments.repository.js";

/**
 * What an invoice still owes. `paidTotal` is the stored Σ of its payments, kept in step inside
 * every payment transaction — the ONE figure the DTO, the SQL filters and every rule below read,
 * so a screen and a guard can never disagree about how much came in.
 */
const balanceOf = (inv: { amount: number; paidTotal: number; cancelledAt: Date | null }) =>
  inv.cancelledAt ? 0 : Math.max(0, inv.amount - inv.paidTotal);

export function toInvoiceDto(
  inv: repo.InvoiceRecord,
  todayMs: number = todayBusinessMs(config.TZ),
) {
  const paid = inv.paidTotal;
  return {
    id: inv.id,
    number: inv.number,
    clientId: inv.clientId,
    clientName: clientLabel(inv.client),
    companyId: inv.companyId,
    companyName: inv.company?.name ?? null,
    serviceId: inv.serviceId,
    serviceName: inv.service?.name ?? null,
    subscriptionId: inv.subscriptionId,
    periodKey: inv.periodKey,
    description: inv.description,
    amount: inv.amount,
    paid,
    // a cancelled invoice owes nothing — it drops out of debt and the unpaid list
    balance: balanceOf(inv),
    status: deriveStatus(
      { amount: inv.amount, paid, dueDate: inv.dueDate, cancelledAt: inv.cancelledAt },
      todayMs,
    ),
    dueDate: inv.dueDate?.toISOString() ?? null,
    issuedAt: inv.issuedAt.toISOString(),
    cancelledAt: inv.cancelledAt?.toISOString() ?? null,
    cancelledByName: inv.cancelledBy ? personName(inv.cancelledBy) : null,
    archivedAt: inv.archivedAt?.toISOString() ?? null,
    archivedByName: inv.archivedBy ? personName(inv.archivedBy) : null,
    clientArchived: inv.client.archivedAt != null,
    delivery: inv.sentAt ? ("sent" as const) : ("created" as const),
    sentAt: inv.sentAt?.toISOString() ?? null,
    sentByName: inv.sentBy ? personName(inv.sentBy) : null,
    taskId: inv.tasks[0]?.id ?? null,
    taskTitle: inv.tasks[0]?.title ?? null,
    payments: inv.payments.map((p) => ({
      id: p.id,
      invoiceId: p.invoiceId,
      amount: p.amount,
      paidAt: p.paidAt.toISOString(),
      reference: p.reference,
      createdById: p.createdById,
      createdByName: personName(p.createdBy),
      createdAt: p.createdAt.toISOString(),
    })),
  };
}

export type InvoiceDto = ReturnType<typeof toInvoiceDto>;

// ── list ─────────────────────────────────────────────────────────────────────

/**
 * Every filter, count and total is answered by the database — settlement included, since
 * `Invoice.paidTotal` is kept in step inside each payment transaction. Nothing is scanned in
 * memory, so the screen behaves the same with a hundred invoices or a hundred thousand.
 */
export async function listInvoices(query: InvoiceListQuery) {
  const todayMs = todayBusinessMs(config.TZ);
  // structural scope shared by every chip: this client / company / search text
  const base: Prisma.InvoiceWhereInput = {};
  if (query.clientId) base.clientId = query.clientId;
  if (query.companyId) base.companyId = query.companyId === "root" ? null : query.companyId;
  if (query.search) {
    const contains = { contains: query.search, mode: "insensitive" as const };
    base.OR = [
      { number: contains },
      { description: contains },
      {
        client: {
          OR: [{ firstName: contains }, { lastName: contains }, { companyName: contains }],
        },
      },
    ];
  }

  // Settlement lives in SQL: `paidTotal` is stored, so "still owed" is a field-to-field
  // comparison and "overdue" adds the due-day boundary — no invoice is read to decide a filter.
  const { OWED: owed, SETTLED: settled } = repo;
  // overdue = the whole due DAY has passed, counted in the FIRM's timezone — exactly the
  // boundary `deriveStatus` uses, so the chip count and the row's own pill always agree
  const pastDue: Prisma.InvoiceWhereInput = { dueDate: { lt: new Date(todayMs) } };

  const live = { ...base, cancelledAt: null, archivedAt: null };
  const scopes: Record<InvoiceListQuery["filter"], Prisma.InvoiceWhereInput> = {
    all: live,
    unpaid: { ...live, ...owed },
    overdue: { ...live, ...owed, ...pastDue },
    paid: { ...live, ...settled },
    unsent: { ...live, sentAt: null },
    cancelled: { ...base, cancelledAt: { not: null }, archivedAt: null },
    archived: { ...base, archivedAt: { not: null } },
  };
  const where = scopes[query.filter];

  const [rows, total, counts, receivable, overdue] = await Promise.all([
    repo.listInvoicePage(where, (query.page - 1) * query.pageSize, query.pageSize),
    repo.countInvoices(where),
    // every chip's badge — cheap indexed counts, not a scan
    Promise.all(
      (Object.keys(scopes) as InvoiceListQuery["filter"][]).map((key) =>
        repo.countInvoices(scopes[key]).then((n) => [key, n] as const),
      ),
    ).then((pairs) => Object.fromEntries(pairs) as Record<InvoiceListQuery["filter"], number>),
    repo.sumInvoices({ ...where, cancelledAt: null }),
    repo.sumInvoices({ ...where, cancelledAt: null, ...owed, ...pastDue }),
  ]);

  return {
    items: rows.map((inv) => toInvoiceDto(inv, todayMs)),
    total,
    page: query.page,
    pageSize: query.pageSize,
    totals: { receivable, overdue },
    counts,
  };
}

/** Also the "return the fresh invoice" reply of every payment mutation. */
export async function getInvoice(id: string) {
  const invoice = await repo.findInvoice(id);
  if (!invoice) throw new NotFoundError("Invoice not found");
  return toInvoiceDto(invoice);
}

// ── manual issue ─────────────────────────────────────────────────────────────

/**
 * "+ New invoice". A subscription pins service + company exactly like a task does;
 * without one it's a bare charge on the client. `withTask` opens the job for it.
 */
export async function createInvoice(input: CreateInvoiceInput, user: User) {
  const client = await repo.findClient(input.clientId);
  if (!client || client.archivedAt) throw new NotFoundError("Client not found");

  let companyId: string | null = null;
  let serviceId: string | null = null;
  let serviceName: string | null = null;
  let dueDays: number | null = null;

  if (input.subscriptionId) {
    const sub = await repo.findSubscription(input.subscriptionId);
    if (!sub || sub.clientId !== input.clientId) {
      throw new ValidationError("That service isn't one of this client's");
    }
    companyId = sub.companyId;
    serviceId = sub.serviceId;
    serviceName = sub.service.name;
    dueDays = sub.dueDays ?? sub.service.dueDays; // per-client override wins
  }

  if (input.withTask && input.assigneeIds.length > 0) {
    const active = await repo.countActiveUsers([...new Set(input.assigneeIds)]);
    if (active !== new Set(input.assigneeIds).size) {
      throw new ValidationError("Assign the task to active team members only");
    }
  }

  const invoice = await issueInvoice({
    clientId: input.clientId,
    companyId,
    serviceId,
    subscriptionId: input.subscriptionId ?? null,
    description: input.description ?? null,
    amount: input.amount,
    // a date sets it · explicit null = no due date at all · omitted = inherit the service's dueDays
    dueDate: input.dueDate === undefined ? undefined : input.dueDate ? dateToUtc(input.dueDate) : null,
    dueDays,
    createdById: user.id,
  });

  if (input.withTask) {
    await repo.createInvoiceTask({
      title: input.taskTitle || input.description || serviceName || `Invoice ${invoice.number}`,
      clientId: input.clientId,
      companyId,
      serviceId,
      subscriptionId: input.subscriptionId ?? null,
      amount: input.amount,
      invoiceId: invoice.id,
      description: input.description ?? null,
      createdById: user.id,
      assigneeIds: input.assigneeIds,
    });
  }

  return getInvoice(invoice.id);
}

/**
 * Correct an issued invoice (admin). The amount may never fall below what's already been
 * paid, a cancelled invoice is frozen, and a linked job's price follows the invoice so the
 * task never shows a different number than the client was billed. Journalled like a payment
 * change (the log is invoice-scoped; `paymentId` stays null for an invoice-level edit).
 */
export async function updateInvoice(id: string, input: UpdateInvoiceInput, user: User) {
  const invoice = await repo.findInvoice(id);
  if (!invoice) throw new NotFoundError("Invoice not found");
  if (invoice.cancelledAt) throw new ValidationError("A cancelled invoice can't be edited");

  if (input.amount !== undefined && input.amount < invoice.paidTotal) {
    throw new ValidationError("The amount can't be less than what's already been paid");
  }

  const before = { amount: invoice.amount, description: invoice.description, dueDate: invoice.dueDate?.toISOString() ?? null };
  const updated = await repo.updateInvoice(id, {
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ...(input.description !== undefined ? { description: input.description ?? null } : {}),
    ...(input.dueDate !== undefined
      ? { dueDate: input.dueDate ? dateToUtc(input.dueDate) : null }
      : {}),
  });
  if (input.amount !== undefined && input.amount !== invoice.amount) {
    await repo.syncTaskAmounts(id, input.amount);
  }
  await repo.writeAudit({
    invoiceId: id,
    paymentId: null, // an invoice-level correction, not a payment
    action: "updated",
    byUserId: user.id,
    before,
    after: { amount: updated.amount, description: updated.description, dueDate: updated.dueDate?.toISOString() ?? null },
  });
  await unarchiveIfOwed(id);
  return getInvoice(id);
}

/**
 * Tidy settled invoices out of the working lists (or bring them back). Only a ZERO-BALANCE
 * invoice — fully paid or cancelled — can be archived, so archiving can never hide debt.
 * Reversible, so it's not admin-gated.
 */
export async function setArchived(input: BulkArchiveInput, user: User) {
  const invoices = await repo.findInvoices(input.invoiceIds);
  const eligible = invoices.filter((inv) => {
    if (!input.archived) return inv.archivedAt != null;
    if (inv.archivedAt) return false;
    return balanceOf(inv) === 0; // nothing owed (settled or voided)
  });
  if (eligible.length > 0) {
    await repo.setArchived(eligible.map((inv) => inv.id), input.archived, user.id);
  }
  return { changed: eligible.length, skipped: input.invoiceIds.length - eligible.length };
}

/**
 * Archiving is only allowed on a settled invoice — but a later correction (a deleted or reduced
 * payment, a raised amount) can put money back on it. An owed invoice must never stay hidden,
 * so it comes back to the working list by itself.
 */
async function unarchiveIfOwed(invoiceId: string) {
  const invoice = await repo.findInvoice(invoiceId);
  if (!invoice?.archivedAt || invoice.cancelledAt) return;
  if (balanceOf(invoice) > 0) await repo.clearArchived([invoiceId]);
}

/** Bulk "mark as sent" from the list — same rule as the single toggle, cancelled ones skipped. */
export async function setDeliveryMany(input: BulkDeliveryInput, user: User) {
  const invoices = await repo.findInvoices(input.invoiceIds);
  const eligible = invoices.filter(
    (inv) => !inv.cancelledAt && (input.sent ? inv.sentAt == null : inv.sentAt != null),
  );
  if (eligible.length > 0) {
    await repo.setDeliveryMany(eligible.map((inv) => inv.id), input.sent, user.id);
  }
  return { changed: eligible.length, skipped: input.invoiceIds.length - eligible.length };
}

/**
 * Mark the invoice as handed to the client — or take the mark back (mis-click).
 * Manual today; sending it by email / attaching a PDF (S10) will stamp the same field,
 * so nothing here has to change when that lands.
 */
export async function setDelivery(id: string, input: SetDeliveryInput, user: User) {
  const invoice = await repo.findInvoice(id);
  if (!invoice) throw new NotFoundError("Invoice not found");
  if (invoice.cancelledAt) throw new ValidationError("This invoice is cancelled");
  return toInvoiceDto(await repo.setInvoiceDelivery(id, input.sent, user.id));
}

/** Void (never delete): the row stays for history but owes nothing. Admin only. */
export async function cancelInvoice(id: string, user: User) {
  const invoice = await repo.findInvoice(id);
  if (!invoice) throw new NotFoundError("Invoice not found");
  if (invoice.cancelledAt) throw new ValidationError("This invoice is already cancelled");
  if (invoice.payments.length > 0) {
    throw new ValidationError("Delete the payments on this invoice before cancelling it");
  }
  return toInvoiceDto(await repo.cancelInvoice(id, user.id));
}

// ── payments ─────────────────────────────────────────────────────────────────

const snapshot = (p: { id: string; amount: number; paidAt: Date; reference: string | null }) => ({
  id: p.id,
  amount: p.amount,
  paidAt: p.paidAt.toISOString(),
  reference: p.reference,
});

/**
 * Any user may register a payment (admin-only edits/deletes are the guardrail).
 * The balance is re-checked under a row lock inside the insert's transaction, so two
 * payments racing on the same invoice can't both pass the check and overshoot the total.
 */
export async function addPayment(invoiceId: string, input: AddPaymentInput, user: User) {
  const invoice = await repo.findInvoice(invoiceId);
  if (!invoice) throw new NotFoundError("Invoice not found");

  const { payment, reason } = await repo.createPaymentChecked({
    invoiceId,
    amount: input.amount,
    paidAt: dateToUtc(input.paidAt),
    reference: input.reference ?? null,
    createdById: user.id,
  });
  if (!payment) {
    if (reason === "cancelled") throw new ValidationError("This invoice is cancelled");
    if (reason === "settled") throw new ValidationError("This invoice is already fully paid");
    throw new ValidationError("Amount is more than what's left to pay on this invoice");
  }

  await repo.writeAudit({
    invoiceId,
    paymentId: payment.id,
    action: "created",
    byUserId: user.id,
    after: snapshot(payment),
  });
  return getInvoice(invoiceId);
}

/** Admin fixes a mistyped payment; every change lands in the journal. */
export async function updatePayment(id: string, input: UpdatePaymentInput, user: User) {
  const payment = await repo.findPayment(id);
  if (!payment) throw new NotFoundError("Payment not found");

  const amount = input.amount ?? payment.amount;
  const others = await repo.sumOtherPayments(payment.invoiceId, id);
  if (others + amount > payment.invoice.amount) {
    throw new ValidationError("Payments would exceed the invoice total");
  }

  const before = snapshot(payment);
  const updated = await repo.updatePayment(id, payment.invoiceId, {
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ...(input.paidAt !== undefined ? { paidAt: dateToUtc(input.paidAt) } : {}),
    ...(input.reference !== undefined ? { reference: input.reference ?? null } : {}),
  });
  await repo.writeAudit({
    invoiceId: payment.invoiceId,
    paymentId: id,
    action: "updated",
    byUserId: user.id,
    before,
    after: snapshot(updated),
  });
  await unarchiveIfOwed(payment.invoiceId);
  return getInvoice(payment.invoiceId);
}

export async function removePayment(id: string, user: User) {
  const payment = await repo.findPayment(id);
  if (!payment) throw new NotFoundError("Payment not found");
  const before = snapshot(payment);
  await repo.deletePayment(id, payment.invoiceId);
  await repo.writeAudit({
    invoiceId: payment.invoiceId,
    paymentId: null, // the row is gone; the snapshot is the record
    action: "deleted",
    byUserId: user.id,
    before,
  });
  await unarchiveIfOwed(payment.invoiceId);
  return getInvoice(payment.invoiceId);
}

/** Billing footer: settle several invoices at once (pays out the remaining balance on each). */
export async function markPaid(input: MarkPaidInput, user: User) {
  const invoices = await repo.findInvoices(input.invoiceIds);
  const paidAt = input.paidAt ? dateToUtc(input.paidAt) : new Date();
  let settled = 0;
  let skipped = 0;

  for (const invoice of invoices) {
    const balance = balanceOf(invoice);
    if (balance <= 0) {
      skipped++; // cancelled or already settled
      continue;
    }
    const { payment } = await repo.createPaymentChecked({
      invoiceId: invoice.id,
      amount: balance,
      paidAt,
      createdById: user.id,
    });
    if (!payment) {
      skipped++; // someone settled it between the read and the write
      continue;
    }
    await repo.writeAudit({
      invoiceId: invoice.id,
      paymentId: payment.id,
      action: "created",
      byUserId: user.id,
      after: snapshot(payment),
    });
    settled++;
  }
  return { settled, skipped: skipped + (input.invoiceIds.length - invoices.length) };
}

export async function listAudit(invoiceId: string) {
  const rows = await repo.listAudit(invoiceId);
  return rows.map((r) => ({
    id: r.id,
    invoiceId: r.invoiceId,
    paymentId: r.paymentId,
    action: r.action,
    byUserId: r.byUserId,
    byUserName: personName(r.byUser),
    before: r.before,
    after: r.after,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ── debt (consumed by the Clients module) ────────────────────────────────────

/** Σ open balance per client — cancelled invoices and overpayments never count. */
export async function debtByClient(clientIds: string[]): Promise<Record<string, number>> {
  const debts: Record<string, number> = {};
  if (clientIds.length === 0) return debts;
  for (const row of await repo.groupOpenBalances([...new Set(clientIds)])) {
    debts[row.clientId] = Math.max(0, (row._sum.amount ?? 0) - (row._sum.paidTotal ?? 0));
  }
  return debts;
}
