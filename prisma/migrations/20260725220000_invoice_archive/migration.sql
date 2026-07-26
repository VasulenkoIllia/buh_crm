-- Invoice archive: tidy settled billing out of the working lists without deleting anything.
-- Only zero-balance invoices (fully paid or cancelled) may be archived, so no debt is ever hidden.
ALTER TABLE "Invoice"
  ADD COLUMN "archivedAt"   TIMESTAMP(3),
  ADD COLUMN "archivedById" UUID;

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_archivedById_fkey"
    FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Invoice_archivedAt_idx" ON "Invoice"("archivedAt");
