import { config } from "../../core/config.js";
import { prisma } from "../../core/db.js";

/**
 * Minimal invoice creation for one-time job tasks (S6). The full Payments
 * module (S7) owns invoices, payments and status — this is only the "issue an
 * invoice for a billable job" slice, kept here so ad-hoc jobs bill on create.
 * S7 will reuse `nextInvoiceNumber` + this helper.
 *
 * Numbering (decision 2026-07-17): PREFIX-YEAR-NNNN, counter resets yearly.
 * We derive the next counter from the count of invoices already numbered for
 * the firm-year and retry on the unique-number collision (concurrent issue).
 */

function firmYear(): number {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: config.TZ }).format(new Date());
  return Number(s.slice(0, 4));
}

async function nextInvoiceNumber(): Promise<string> {
  const firm = await prisma.firmProfile.findUnique({ where: { id: 1 } });
  const prefix = firm?.invoicePrefix ?? "INV";
  const digits = firm?.invoiceCounterDigits ?? 4;
  const year = firmYear();
  const used = await prisma.invoice.count({ where: { number: { startsWith: `${prefix}-${year}-` } } });
  return `${prefix}-${year}-${String(used + 1).padStart(digits, "0")}`;
}

export interface JobInvoiceInput {
  taskId: string;
  clientId: string;
  companyId: string | null;
  serviceId: string | null;
  amount: number;
  /** service.dueDays (per-client override wins) — invoice overdue after N days */
  dueDays: number | null;
}

/**
 * Issue an invoice for a one-time job and link it to the task. Retries the
 * number a few times if another issue raced us to the same counter.
 */
export async function issueJobInvoice(input: JobInvoiceInput) {
  const issuedAt = new Date();
  const dueDate =
    input.dueDays != null ? new Date(issuedAt.getTime() + input.dueDays * 86_400_000) : null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const number = await nextInvoiceNumber();
    try {
      const invoice = await prisma.invoice.create({
        data: {
          number,
          clientId: input.clientId,
          companyId: input.companyId,
          serviceId: input.serviceId,
          amount: input.amount,
          issuedAt,
          dueDate,
          tasks: { connect: { id: input.taskId } },
        },
      });
      return invoice;
    } catch (err) {
      // unique number collision under concurrency → recompute and retry
      if (err && typeof err === "object" && "code" in err && err.code === "P2002") continue;
      throw err;
    }
  }
  throw new Error("Could not allocate a unique invoice number");
}
