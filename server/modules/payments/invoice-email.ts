/**
 * **Send by email** (payments.md §12, owner 2026-11-22): the invoice's PDF to the address the paper
 * prints, from the mailbox marked for invoices, with the template marked for them. Mailouts writes
 * and sends the letter; this side decides which invoice may go, attaches its paper and stamps the
 * sent mark.
 *
 * Only by a button: nothing emails an invoice on its own (owner). Pressed again, it sends the paper
 * as it is now, and the first sent mark stays.
 */
import type { Invoice, InvoiceEmailPreview } from "@shared/schema/payment.js";
import { fmtMoney } from "@shared/money.js";
import type { User } from "../../generated/prisma/client.js";
import { record } from "../../core/activity.js";
import { AppError, ConflictError, ValidationError } from "../../core/errors.js";
import {
  previewInvoiceLetter,
  sendInvoiceLetter,
  type InvoiceLetterRequest,
} from "../mailouts/index.js";
import { invoicePaper, paperPdf } from "./payments.pdf.js";
import * as repo from "./payments.repository.js";
import { getInvoice } from "./payments.service.js";

type Paper = Awaited<ReturnType<typeof invoicePaper>>;

/**
 * Invoices being sent right now. One process serves the firm, so a set is enough to stop a double
 * click or a second tab from mailing the client twice; a deliberate second send waits for the first.
 */
const sending = new Set<string>();

/**
 * What stops this invoice whatever the firm's setup: Billing's own rule, before the letter's. An
 * archived client is the letter's (Mailouts writes only to a client it may write to).
 */
function invoiceRefusal({ invoice }: Paper): string | null {
  return invoice.cancelledAt ? "This invoice is cancelled" : null;
}

/** The letter's addressee and values, read off the paper, so both say the same thing. */
function letterRequest({ invoice, document, dto }: Paper): InvoiceLetterRequest {
  return {
    clientId: invoice.clientId,
    companyId: invoice.companyId,
    to: document.billTo.email,
    invoice: {
      invoice_number: document.number,
      amount: document.total,
      balance: fmtMoney(dto.balance),
      due_date: document.dueDate,
    },
  };
}

export async function invoiceEmailPreview(id: string): Promise<InvoiceEmailPreview> {
  const paper = await invoicePaper(id);
  const letter = await previewInvoiceLetter(letterRequest(paper));
  const refused = invoiceRefusal(paper);
  return {
    ...letter,
    fileName: paper.name,
    blockedReason: refused ?? letter.blockedReason,
    html: refused ? null : letter.html,
  };
}

export async function emailInvoice(id: string, user: User): Promise<Invoice> {
  if (sending.has(id)) throw new ConflictError("This invoice is being sent right now");
  sending.add(id);
  try {
    const paper = await invoicePaper(id);
    const refused = invoiceRefusal(paper);
    if (refused) throw new ValidationError(refused);
    const sent = await sendInvoiceLetter(letterRequest(paper), async () => ({
      filename: paper.name,
      content: (await paperPdf(paper)).buffer,
    }));

    // The letter has gone, so a mark that fails to save must not read as a letter that failed: the
    // person would press Send again and the client get two.
    const isMarked = await repo.stampSentIfUnsent(id, user.id).then(
      () => true,
      (err: unknown) => {
        console.error(
          `[payments] invoice=${id} was emailed, its sent mark was not saved:`,
          err,
        );
        return false;
      },
    );
    record("invoice.emailed", {
      subjectId: id,
      subjectLabel: paper.invoice.number,
      clientId: paper.invoice.clientId,
      changes: { to: sent.to, mailbox: sent.mailbox },
    });
    if (!isMarked) {
      throw new AppError(
        500,
        "sent_mark_failed",
        `The invoice went to ${sent.to}, but its sent mark was not saved. Use Mark as sent`,
      );
    }
    return getInvoice(id);
  } finally {
    sending.delete(id);
  }
}
