-- An invoice can say what its total is made of.
--
-- Until now an amount was one number plus a free-text description, so "3.50 hours at 200" could
-- only be written as prose. Lines make it structured — and stay OPTIONAL: an invoice without them
-- is a single amount and behaves exactly as every invoice does today.
--
-- No `type` column on Invoice, deliberately. The difference is "does it have a breakdown", which
-- the presence of lines already answers; a stored type would remember which form was filled in
-- rather than what is true about the document, and every screen would then branch on it.

CREATE TABLE "InvoiceLine" (
  "id"          UUID    PRIMARY KEY,
  "invoiceId"   UUID    NOT NULL,
  "order"       INTEGER NOT NULL,
  "description" TEXT    NOT NULL,
  -- hundredths of an hour: 2.50 h = 250. Integers like money — a float hour times a rate is
  -- where the last cent goes missing.
  "quantity"    INTEGER,
  "unitRate"    INTEGER,
  "amount"      INTEGER NOT NULL
);

-- CASCADE: a line is part of its invoice, not history of its own. In practice it never fires —
-- invoices are voided, never deleted.
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");
