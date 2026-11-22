-- One letter template can be the one an invoice is emailed with (payments.md §12).
--
-- Additive: a column with a default, so every existing template reads "not the invoice template"
-- and nothing is rewritten. Nothing is marked here: the firm writes the letter and picks it under
-- Mailouts -> Templates, and until it does, Send by email on an invoice says so.

ALTER TABLE "EmailTemplate" ADD COLUMN "isInvoiceTemplate" BOOLEAN NOT NULL DEFAULT false;

-- At most one, enforced rather than trusted, as "MailSenderAccount_one_invoice_sender": two would
-- make which text a client's invoice arrives with depend on row order.
CREATE UNIQUE INDEX "EmailTemplate_one_invoice_template"
  ON "EmailTemplate"("isInvoiceTemplate") WHERE "isInvoiceTemplate";
