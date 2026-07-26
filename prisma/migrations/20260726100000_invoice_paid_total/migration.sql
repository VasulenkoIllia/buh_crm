-- Σ payments stored on the invoice, maintained inside every payment transaction.
-- Denormalized deliberately: settlement filters (unpaid / partial / paid / overdue), the list
-- totals and each client's debt become plain SQL instead of an in-memory scan over every invoice.
ALTER TABLE "Invoice" ADD COLUMN "paidTotal" INTEGER NOT NULL DEFAULT 0;

UPDATE "Invoice" i
SET "paidTotal" = COALESCE((SELECT SUM(p."amount") FROM "Payment" p WHERE p."invoiceId" = i."id"), 0);

-- the working list is "live invoices, newest first"
CREATE INDEX "Invoice_cancelledAt_archivedAt_issuedAt_idx"
  ON "Invoice"("cancelledAt", "archivedAt", "issuedAt");
