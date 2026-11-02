import type { User } from "../../generated/prisma/client.js";
import { record } from "../../core/activity.js";
import { NotFoundError } from "../../core/errors.js";
import { isPrintableLogo, readInvoiceIssuer, type InvoiceIssuer } from "../../core/firm.js";
import { readStoredFile } from "../../core/files.js";
import { copyIntoLibrary } from "../files/index.js";
import { invoiceDocument, invoiceFileName } from "./invoice-document.js";
import { renderInvoicePdf } from "./invoice-pdf.js";
import * as repo from "./payments.repository.js";
import { toInvoiceDto } from "./payments.service.js";

const PDF_TYPE = "application/pdf";

/** Bytes that cannot be fetched cost the logo, as they do a letter (`loadLogo` in Mailouts). */
async function readLogo(logoFile: InvoiceIssuer["logoFile"]) {
  if (!logoFile || !isPrintableLogo(logoFile)) return null;
  try {
    return await readStoredFile(logoFile);
  } catch (error) {
    console.error(
      "[invoice-pdf] the letter logo could not be read; printing without it",
      error,
    );
    return null;
  }
}

/**
 * What an invoice's paper says (payments.md §10). Drawn every time, from what is true now, except
 * the payment details: those are the copy the invoice took at issue, so editing a set never changes
 * a paper already sent (owner, 2026-11-02). Only an invoice with no copy, issued before sets existed
 * or while there were none, prints what its client would get today.
 */
export async function invoicePaper(id: string) {
  const invoice = await repo.findInvoice(id);
  if (!invoice) throw new NotFoundError("Invoice not found");
  const { logoFile, ...issuer } = await readInvoiceIssuer();
  const paymentInfo =
    invoice.paymentInfo ??
    (await repo.findPaymentDetailsFor(invoice.clientId))?.details ??
    null;
  // `Company.email` is that company's invoice address; with none, the client's own
  const billToEmail = invoice.company?.email ?? invoice.client.email;
  const document = invoiceDocument(
    toInvoiceDto(invoice),
    { ...issuer, paymentInfo },
    billToEmail,
  );
  return { invoice, document, logoFile };
}

/**
 * An invoice as a PDF. The file in a client's folder is the copy that stays as it was. Reading one
 * changes nothing about the invoice. "Sent" stays a person's mark, because downloading a paper does
 * not hand it over.
 */
export async function invoicePdf(id: string) {
  const { invoice, document, logoFile } = await invoicePaper(id);
  const logo = await readLogo(logoFile);
  return {
    invoice,
    name: invoiceFileName(invoice.number),
    buffer: await renderInvoicePdf(document, logo),
  };
}

/**
 * A copy in the client's Shared with client zone: an ordinary upload, so its name is made unique,
 * and `file.uploaded` and `file.shared_with_client` are written the way any other file's are. The
 * library's gate is asked inside `copyIntoLibrary`, because this route is Billing's.
 */
export async function saveInvoicePdf(id: string, user: User) {
  const { invoice, name, buffer } = await invoicePdf(id);
  const file = await copyIntoLibrary(
    user,
    { space: "client", clientId: invoice.clientId, zone: "shared" },
    undefined,
    { buffer, filename: name, mimetype: PDF_TYPE },
  );
  record("invoice.pdf_saved", {
    subjectId: invoice.id,
    subjectLabel: invoice.number,
    clientId: invoice.clientId,
    changes: { file: file.name },
  });
  return { fileId: file.id, name: file.name };
}
