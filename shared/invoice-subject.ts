import { periodLabel } from "./billing-periods.js";
import type { Invoice } from "./schema/payment.js";

type Source = Pick<Invoice, "serviceName" | "description" | "periodKey" | "taskTitle">;

/**
 * What an invoice is for, in the two lines Billing's Service cell and the PDF's row both show.
 * Here because both ask: two copies of this choice would soon name one invoice two ways.
 */

/** What a Billing row's Service cell leads with: the service, or the text of an invoice with none. */
export const invoiceSubject = (invoice: Source): string | null =>
  invoice.serviceName ?? invoice.description ?? null;

/**
 * The Service cell's second line: whatever tells two invoices for the same service apart.
 *
 * The period for a subscription's invoice, as dates ("1–15 Oct 2026", `periodLabel`), the job for
 * a one-off, and otherwise the invoice's own text. Two "Customer support · $0.00" rows on one
 * client read as duplicates until each names its job (owner, 2026-10-07). A line that only repeats
 * the first is dropped: a job opened from "+ New invoice" takes its title from the description or
 * the service name.
 */
export function invoiceDetail(invoice: Source): string | null {
  const subject = invoiceSubject(invoice)?.trim().toLowerCase();
  // the trimmed text when it says something the first line does not, else null
  const adds = (text: string | null) => {
    const trimmed = text?.trim();
    return trimmed && trimmed.toLowerCase() !== subject ? trimmed : null;
  };
  const period = invoice.periodKey?.trim();
  return (
    (period && periodLabel(period)) || adds(invoice.taskTitle) || adds(invoice.description)
  );
}
