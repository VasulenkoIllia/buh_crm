-- S7 Payments: invoice lifecycle (manual issue + cancel), payment reference,
-- transactional invoice numbering, and a per-subscription billing anchor.

-- Invoice: free-text description (manual invoices), issuer, and cancel (void) marks.
ALTER TABLE "Invoice"
  ADD COLUMN "description"   TEXT,
  ADD COLUMN "createdById"   UUID,
  ADD COLUMN "cancelledAt"   TIMESTAMP(3),
  ADD COLUMN "cancelledById" UUID;

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Invoice_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Payment: external reconcile number (bank statement / accounting system).
ALTER TABLE "Payment" ADD COLUMN "reference" TEXT;

-- Subscription: billing anchor — no invoice is ever issued for a period before it.
-- Set to "now" on create and on reactivation, so a paused subscription is not back-billed.
-- Existing subscriptions are anchored to the deploy moment: per-period billing starts with the
-- CURRENT period, so switching S7 on never back-bills months that predate it. (NULL keeps the
-- createdAt fallback as a safety net for rows written outside the app.)
ALTER TABLE "Subscription" ADD COLUMN "billingStartAt" TIMESTAMP(3);
UPDATE "Subscription" SET "billingStartAt" = now();

-- Invoice numbering: an allocated counter instead of counting rows (S6 derived the next number
-- from COUNT(*), which races and re-uses a number after a cancel). Seeded from the numbers that
-- already exist for the current firm year so the sequence continues instead of colliding.
ALTER TABLE "FirmProfile"
  ADD COLUMN "invoiceCounterYear" INTEGER,
  ADD COLUMN "invoiceCounter"     INTEGER NOT NULL DEFAULT 0;

UPDATE "FirmProfile" f
SET "invoiceCounterYear" = EXTRACT(YEAR FROM now())::int,
    "invoiceCounter" = (
      SELECT COALESCE(MAX(NULLIF(regexp_replace(i."number", '^.*-', ''), '')::int), 0)
      FROM "Invoice" i
      WHERE i."number" LIKE f."invoicePrefix" || '-' || EXTRACT(YEAR FROM now())::int || '-%'
        AND i."number" ~ '-[0-9]+$'
    );
