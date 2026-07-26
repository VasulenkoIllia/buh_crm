-- Invoice delivery state, orthogonal to payment: created (sentAt IS NULL) → sent.
-- Marked by hand today; the email/PDF path (S10) will stamp the same columns automatically.
ALTER TABLE "Invoice"
  ADD COLUMN "sentAt"   TIMESTAMP(3),
  ADD COLUMN "sentById" UUID;

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_sentById_fkey"
    FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- "which invoices still have to go out" is a working filter on the Billing screen
CREATE INDEX "Invoice_sentAt_idx" ON "Invoice"("sentAt");
